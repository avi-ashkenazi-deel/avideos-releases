import Foundation
import Combine
#if canImport(UserNotifications)
import UserNotifications
#endif

/// Follows RSS/Atom feeds (a lightweight Feedly): persists the feed list + items
/// in the app group, refreshes them, detects new items, and — for feeds with
/// notifications turned on — posts a local notification when new items arrive.
@MainActor
final class FeedStore: ObservableObject {

    static let shared = FeedStore()

    @Published private(set) var feeds: [RSSFeed] = []
    @Published private(set) var items: [RSSItem] = []
    @Published private(set) var isRefreshing = false
    @Published var errorMessage: String?

    private let dir = AppGroup.containerURL.appendingPathComponent("Feeds", isDirectory: true)
    private var feedsURL: URL { dir.appendingPathComponent("feeds.json") }
    private var itemsURL: URL { dir.appendingPathComponent("items.json") }

    /// Cap stored items per feed so the file stays small.
    private let maxItemsPerFeed = 100

    private init() {
        load()
    }

    // MARK: - Follow / unfollow / settings

    /// Add a feed by URL. Accepts either a direct feed URL *or* a site URL — in
    /// the latter case it discovers the feed from the page's `<link>` tags, then
    /// falls back to common feed paths (/feed, /rss, …).
    func add(urlString: String) async throws {
        var raw = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.lowercased().hasPrefix("http") { raw = "https://" + raw }
        guard let entered = URL(string: raw) else { throw FeedParser.FeedError.notAFeed }

        let (feedURL, parsed) = try await resolveFeed(from: entered)
        let candidate = RSSFeed(url: feedURL)
        guard !feeds.contains(where: { $0.id == candidate.id }) else { return }

        var feed = candidate
        feed.title = parsed.title ?? feed.title
        feed.siteURL = parsed.siteURL
        feeds.append(feed)
        merge(parsed.items, into: feed)
        persist()
    }

    /// Resolve the entered URL to an actual feed: direct feed → HTML autodiscovery
    /// → common feed paths.
    private func resolveFeed(from url: URL) async throws -> (URL, FeedParser.Result) {
        let (data, _) = try await URLSession.shared.data(from: url)
        if let parsed = try? FeedParser.parse(data: data) {
            return (url, parsed)
        }
        // Treat the response as a web page and look for a declared feed link.
        if let html = String(data: data, encoding: .utf8),
           let discovered = Self.feedLink(inHTML: html, baseURL: url),
           let (feedData, _) = try? await URLSession.shared.data(from: discovered),
           let parsed = try? FeedParser.parse(data: feedData) {
            return (discovered, parsed)
        }
        // Last resort: probe the usual feed paths off the site root.
        for path in ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feed/"] {
            guard let candidate = URL(string: path, relativeTo: url)?.absoluteURL,
                  let (feedData, _) = try? await URLSession.shared.data(from: candidate),
                  let parsed = try? FeedParser.parse(data: feedData) else { continue }
            return (candidate, parsed)
        }
        throw FeedParser.FeedError.notAFeed
    }

    /// Find a feed URL declared in a page's `<link rel="alternate" type="…rss/atom…">`.
    private static func feedLink(inHTML html: String, baseURL: URL) -> URL? {
        guard let linkRegex = try? NSRegularExpression(pattern: "<link[^>]+>", options: [.caseInsensitive]) else {
            return nil
        }
        let ns = html as NSString
        for match in linkRegex.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let tag = ns.substring(with: match.range)
            let lower = tag.lowercased()
            guard lower.contains("application/rss+xml") || lower.contains("application/atom+xml"),
                  let href = attribute("href", in: tag),
                  let url = URL(string: href, relativeTo: baseURL)?.absoluteURL else { continue }
            return url
        }
        return nil
    }

    private static func attribute(_ name: String, in tag: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: "\(name)\\s*=\\s*[\"']([^\"']+)[\"']", options: [.caseInsensitive]) else { return nil }
        let ns = tag as NSString
        guard let m = regex.firstMatch(in: tag, range: NSRange(location: 0, length: ns.length)),
              m.range(at: 1).location != NSNotFound else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    func remove(_ feedID: RSSFeed.ID) {
        feeds.removeAll { $0.id == feedID }
        items.removeAll { $0.feedID == feedID }
        persist()
    }

    /// Toggle per-feed new-item notifications (requests permission on first use).
    func setNotifications(_ enabled: Bool, for feedID: RSSFeed.ID) {
        guard let idx = feeds.firstIndex(where: { $0.id == feedID }) else { return }
        feeds[idx].notifyOnNewItems = enabled
        persist()
        #if canImport(UserNotifications) && !os(watchOS)
        if enabled {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
        }
        #endif
    }

    func feed(for id: RSSFeed.ID) -> RSSFeed? { feeds.first { $0.id == id } }

    // MARK: - Reading state

    func markRead(_ itemID: RSSItem.ID, read: Bool = true) {
        guard let idx = items.firstIndex(where: { $0.id == itemID }) else { return }
        items[idx].isRead = read
        persist()
    }

    var unreadCount: Int { items.filter { !$0.isRead }.count }

    // MARK: - Search

    /// Case-insensitive search across every followed feed (title, summary, feed name).
    func search(_ query: String) -> [RSSItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return items }
        let feedTitles = Dictionary(uniqueKeysWithValues: feeds.map { ($0.id, $0.title.lowercased()) })
        return items.filter {
            $0.title.lowercased().contains(q)
                || ($0.summary?.lowercased().contains(q) ?? false)
                || (feedTitles[$0.feedID]?.contains(q) ?? false)
        }
    }

    // MARK: - Refresh

    /// Refresh every feed. When `notify` is true, feeds with notifications on
    /// post a local notification for newly arrived items.
    func refreshAll(notify: Bool = false) async {
        guard !isRefreshing, !feeds.isEmpty else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        for feed in feeds {
            guard let (data, _) = try? await URLSession.shared.data(from: feed.url),
                  let parsed = try? FeedParser.parse(data: data) else { continue }
            let newCount = merge(parsed.items, into: feed)
            if notify, newCount > 0, feed.notifyOnNewItems {
                postNotification(feed: feed, newCount: newCount, latestTitle: parsed.items.first?.title)
            }
        }
        persist()
    }

    /// Merge parsed items into the store; returns how many were genuinely new.
    @discardableResult
    private func merge(_ parsed: [FeedParser.Item], into feed: RSSFeed) -> Int {
        let known = Set(items.filter { $0.feedID == feed.id }.map(\.id))
        var added = 0
        for p in parsed {
            let id = (p.guid ?? p.link?.absoluteString ?? p.title).lowercased()
            guard !id.isEmpty, !known.contains(id) else { continue }
            items.append(RSSItem(
                id: id, feedID: feed.id, title: p.title, link: p.link,
                summary: p.summary.map(Self.plainText), contentHTML: p.contentHTML,
                publishedAt: p.published ?? Date(), isRead: false
            ))
            added += 1
        }
        if added > 0 {
            items.sort { $0.publishedAt > $1.publishedAt }
            // Trim per feed so storage stays bounded.
            var perFeed: [String: Int] = [:]
            items.removeAll { item in
                perFeed[item.feedID, default: 0] += 1
                return perFeed[item.feedID]! > maxItemsPerFeed
            }
        }
        return added
    }

    /// Collapse summary HTML to a short plain-text excerpt for the row.
    private static func plainText(_ html: String) -> String {
        let stripped = html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(stripped.prefix(280))
    }

    private func postNotification(feed: RSSFeed, newCount: Int, latestTitle: String?) {
        #if canImport(UserNotifications) && !os(watchOS)
        let content = UNMutableNotificationContent()
        content.title = feed.title
        content.body = newCount == 1
            ? (latestTitle ?? "1 new article")
            : "\(newCount) new articles" + (latestTitle.map { " — latest: \($0)" } ?? "")
        content.sound = .default
        let request = UNNotificationRequest(identifier: "feed-\(feed.id)-\(Date().timeIntervalSince1970)",
                                            content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
        #endif
    }

    // MARK: - Persistence

    private func load() {
        if let data = try? Data(contentsOf: feedsURL),
           let list = try? JSONDecoder.iso.decode([RSSFeed].self, from: data) {
            feeds = list
        }
        if let data = try? Data(contentsOf: itemsURL),
           let list = try? JSONDecoder.iso.decode([RSSItem].self, from: data) {
            items = list
        }
    }

    private func persist() {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder.iso.encode(feeds) { try? data.write(to: feedsURL, options: .atomic) }
        if let data = try? JSONEncoder.iso.encode(items) { try? data.write(to: itemsURL, options: .atomic) }
    }
}
