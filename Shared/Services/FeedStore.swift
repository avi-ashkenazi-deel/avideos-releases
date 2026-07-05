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

    /// Set when the user turned on notifications but the system permission is off,
    /// so the UI can offer a jump to Settings instead of silently doing nothing.
    @Published var notificationsDenied = false

    /// The app target sets this so the store can ask `BGTaskScheduler` to (re)schedule
    /// a background refresh the moment the user opts in. (The scheduler itself lives
    /// in the app target; this shared store can't reach it directly.)
    var onRequestBackgroundRefresh: (() -> Void)?

    private let defaults = UserDefaults.voiceInbox
    private static let pitchSeenKey = "feeds.seenNotificationsPitch"

    /// Whether the one-time "get notified about new articles" pitch has been shown
    /// (on the first feed the user adds). Persisted so it only ever appears once.
    var hasSeenNotificationsPitch: Bool {
        get { defaults.bool(forKey: Self.pitchSeenKey) }
        set { defaults.set(newValue, forKey: Self.pitchSeenKey) }
    }

    func markNotificationsPitchSeen() { hasSeenNotificationsPitch = true }

    private let dir = AppGroup.containerURL.appendingPathComponent("Feeds", isDirectory: true)
    private var feedsURL: URL { dir.appendingPathComponent("feeds.json") }
    private var itemsURL: URL { dir.appendingPathComponent("items.json") }

    /// Cap stored items per feed so the file stays small.
    private let maxItemsPerFeed = 100

    private let cloud = NSUbiquitousKeyValueStore.default
    private static let feedsCloudKey = "feeds-subscriptions"

    private init() {
        load()
        // The list of feeds you follow is backed up to iCloud so it survives
        // deleting/reinstalling the app. Items aren't — they re-fetch on refresh.
        mergeFeedsFromCloud()
        NotificationCenter.default.addObserver(
            forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: cloud, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.mergeFeedsFromCloud() }
        }
        cloud.synchronize()
    }

    // MARK: - Follow / unfollow / settings

    /// Add a feed by URL. Accepts either a direct feed URL *or* a site URL — in
    /// the latter case it discovers the feed from the page's `<link>` tags, then
    /// falls back to common feed paths (/feed, /rss, …).
    @discardableResult
    func add(urlString: String) async throws -> RSSFeed.ID {
        var raw = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !raw.lowercased().hasPrefix("http") { raw = "https://" + raw }
        guard let entered = URL(string: raw) else { throw FeedParser.FeedError.notAFeed }

        let (feedURL, parsed) = try await resolveFeed(from: entered)
        let candidate = RSSFeed(url: feedURL)
        // Already following it → just hand back the existing id (so the caller can
        // still flip on notifications for it).
        if let existing = feeds.first(where: { $0.id == candidate.id }) { return existing.id }

        var feed = candidate
        feed.title = parsed.title ?? feed.title
        feed.siteURL = parsed.siteURL
        feeds.append(feed)
        merge(parsed.items, into: feed)
        persist()
        return feed.id
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

    /// Toggle per-feed new-item notifications. Turning it on requests system
    /// permission (the only place we ever ask) and makes sure a background refresh
    /// is scheduled so new articles can actually arrive while the app is closed.
    func setNotifications(_ enabled: Bool, for feedID: RSSFeed.ID) {
        guard let idx = feeds.firstIndex(where: { $0.id == feedID }) else { return }
        feeds[idx].notifyOnNewItems = enabled
        persist()
        if enabled {
            onRequestBackgroundRefresh?()
            Task { await ensureNotificationPermission() }
        }
    }

    /// Ask for notification permission the first time it's needed; afterwards just
    /// reflect whether it's been granted so the UI can nudge toward Settings.
    func ensureNotificationPermission() async {
        #if canImport(UserNotifications) && !os(watchOS)
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        switch status {
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
            notificationsDenied = !granted
        case .denied:
            notificationsDenied = true
        default:
            notificationsDenied = false
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

    /// Mark every stored item read (used by the "Mark all read" toolbar action).
    func markAllRead() {
        guard items.contains(where: { !$0.isRead }) else { return }
        for idx in items.indices { items[idx].isRead = true }
        persist()
    }

    /// The next unread item after the given one, in display order (newest first).
    /// Used to auto-advance playback through the feed.
    func nextUnread(after itemID: String) -> RSSItem? {
        guard let idx = items.firstIndex(where: { $0.id == itemID }) else {
            return items.first { !$0.isRead }
        }
        return items[(idx + 1)...].first { !$0.isRead }
    }

    /// The item `direction` positions from `itemID` in display order (newest
    /// first), ignoring read state — for swipe navigation in the reader. `+1` is
    /// the next (older) item, `-1` the previous. Nil at the ends of the list.
    func sibling(of itemID: String, direction: Int) -> RSSItem? {
        guard let idx = items.firstIndex(where: { $0.id == itemID }) else { return nil }
        let target = idx + direction
        guard items.indices.contains(target) else { return nil }
        return items[target]
    }

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

    /// Short-fused session for feed fetches: don't wait for connectivity and cap
    /// each request, so one slow/dead feed can't stall the whole refresh (the
    /// shared session's 60s default did exactly that).
    private nonisolated static let refreshSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 20
        return URLSession(configuration: cfg)
    }()

    private var lastRefreshAt: Date?

    /// Refresh every feed — all fetched *concurrently* (fetch + parse off the
    /// main actor), then merged in order. When `notify` is true, feeds with
    /// notifications on post a local notification for newly arrived items.
    /// Passive callers (tab appearing) are throttled to once a minute; explicit
    /// ones (pull-to-refresh, background task) pass `force: true`.
    func refreshAll(notify: Bool = false, force: Bool = false) async {
        guard !isRefreshing, !feeds.isEmpty else { return }
        if !force, let last = lastRefreshAt, Date().timeIntervalSince(last) < 60 { return }
        isRefreshing = true
        defer { isRefreshing = false }
        lastRefreshAt = Date()

        // Fetch + parse everything concurrently; wall-clock = slowest feed
        // (capped at the session timeout), not the sum of all of them.
        let snapshot = feeds
        let results: [String: FeedParser.Result] = await withTaskGroup(
            of: (String, FeedParser.Result?).self
        ) { group in
            for feed in snapshot {
                group.addTask {
                    guard let (data, _) = try? await Self.refreshSession.data(from: feed.url),
                          let parsed = try? FeedParser.parse(data: data) else { return (feed.id, nil) }
                    return (feed.id, parsed)
                }
            }
            var out: [String: FeedParser.Result] = [:]
            for await (id, parsed) in group where parsed != nil { out[id] = parsed }
            return out
        }

        for feed in snapshot {
            guard let parsed = results[feed.id] else { continue }
            let newCount = merge(parsed.items, into: feed)
            if notify, newCount > 0, feed.notifyOnNewItems {
                postNotification(feed: feed, newCount: newCount,
                                 latestTitle: parsed.items.first?.title,
                                 latestItemID: parsed.items.first.map(Self.itemID(for:)))
            }
        }
        persist()
    }

    /// Stable id for a parsed feed item (guid, else link, else title).
    nonisolated static func itemID(for p: FeedParser.Item) -> String {
        (p.guid ?? p.link?.absoluteString ?? p.title).lowercased()
    }

    /// Merge parsed items into the store; returns how many were genuinely new.
    @discardableResult
    private func merge(_ parsed: [FeedParser.Item], into feed: RSSFeed) -> Int {
        let known = Set(items.filter { $0.feedID == feed.id }.map(\.id))
        let feedHost = Self.normHost(feed.siteURL?.host ?? feed.url.host)
        var added = 0
        for p in parsed {
            let id = Self.itemID(for: p)
            guard !id.isEmpty, !known.contains(id) else { continue }
            items.append(RSSItem(
                id: id, feedID: feed.id, title: p.title, link: p.link,
                sourceURL: Self.firstExternalLink(in: p.summary ?? p.contentHTML, excludingHost: feedHost),
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

    /// Host without a leading "www." (so techmeme.com and www.techmeme.com match).
    nonisolated static func normHost(_ host: String?) -> String? {
        guard var h = host?.lowercased() else { return nil }
        if h.hasPrefix("www.") { h = String(h.dropFirst(4)) }
        return h.isEmpty ? nil : h
    }

    /// The first http(s) link in some description/content HTML whose host isn't the
    /// feed's own — i.e. the real article an aggregator item points to.
    nonisolated static func firstExternalLink(in html: String?, excludingHost feedHost: String?) -> URL? {
        guard let html, !html.isEmpty,
              let re = try? NSRegularExpression(pattern: "href\\s*=\\s*[\"']([^\"']+)[\"']",
                                                options: [.caseInsensitive]) else { return nil }
        let ns = html as NSString
        for m in re.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let href = ns.substring(with: m.range(at: 1))
            guard let url = URL(string: href), let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https", let host = normHost(url.host) else { continue }
            if let feedHost, host == feedHost { continue }   // skip the aggregator's own links/images
            return url
        }
        return nil
    }

    /// Collapse summary HTML to a short plain-text excerpt for the row.
    private static func plainText(_ html: String) -> String {
        let stripped = html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(stripped.prefix(280))
    }

    private func postNotification(feed: RSSFeed, newCount: Int, latestTitle: String?,
                                  latestItemID: String?) {
        #if canImport(UserNotifications) && !os(watchOS)
        let content = UNMutableNotificationContent()
        content.title = feed.title
        content.body = newCount == 1
            ? (latestTitle ?? "1 new article")
            : "\(newCount) new articles" + (latestTitle.map { " — latest: \($0)" } ?? "")
        content.sound = .default
        // Carry the newest item so tapping the notification opens it directly.
        if let latestItemID {
            content.userInfo = ["feedItemID": latestItemID, "feedID": feed.id]
        }
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
        if let data = try? JSONEncoder.iso.encode(feeds) {
            try? data.write(to: feedsURL, options: .atomic)
            cloud.set(data, forKey: Self.feedsCloudKey)   // back up subscriptions to iCloud
        }
        if let data = try? JSONEncoder.iso.encode(items) { try? data.write(to: itemsURL, options: .atomic) }
    }

    /// Adopt any followed feeds from the iCloud backup we don't already have —
    /// restores subscriptions after a reinstall (when local is empty). Their items
    /// re-fetch on the next refresh.
    private func mergeFeedsFromCloud() {
        guard let data = cloud.data(forKey: Self.feedsCloudKey),
              let remote = try? JSONDecoder.iso.decode([RSSFeed].self, from: data) else { return }
        let knownIDs = Set(feeds.map(\.id))
        let missing = remote.filter { !knownIDs.contains($0.id) }
        guard !missing.isEmpty else { return }
        feeds.append(contentsOf: missing)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let encoded = try? JSONEncoder.iso.encode(feeds) {
            try? encoded.write(to: feedsURL, options: .atomic)
        }
        // Pull in the new feeds' articles.
        Task { await refreshAll(force: true) }
    }
}
