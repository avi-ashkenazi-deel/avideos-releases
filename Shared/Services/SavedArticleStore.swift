import Foundation
import Combine

/// App-side store for saved articles. Reads the shared list written by the
/// Share Extension, fetches + extracts + caches pending items for offline
/// listening, and publishes the list to the UI.
@MainActor
final class SavedArticleStore: ObservableObject {

    static let shared = SavedArticleStore()

    @Published private(set) var articles: [SavedArticle] = []
    @Published private(set) var isProcessing = false

    private var processing = false

    /// Email the saved list is backed up under in iCloud (nil = not signed in /
    /// cloud sync off). Set by `AppState` once it knows who's signed in.
    private var ownerEmail: String?
    private var pushTask: Task<Void, Never>?

    private init() {
        reload()
    }

    // MARK: - iCloud sync

    /// Tie cloud backup to the signed-in email. Passing a new email pulls that
    /// account's saved list down and merges it; nil turns cloud sync off.
    func configureCloud(email: String?) {
        guard email != ownerEmail else { return }
        ownerEmail = email
        guard email != nil else { return }
        Task { await syncWithCloud() }
    }

    /// Pull the email's saved list from iCloud, merge it with what's on device
    /// (re-extracting content that isn't cached here), then push the union back.
    func syncWithCloud() async {
        guard let email = ownerEmail, await SavedArticleCloudSync.shared.isAvailable() else { return }
        let cloud = try? await SavedArticleCloudSync.shared.fetch(forEmail: email)
        var merged = SavedArticleStorage.load()
        if let cloud {
            let localIDs = Set(merged.map(\.id))
            for var item in cloud where !localIDs.contains(item.id) {
                // Content isn't synced; mark it for re-extraction on this device.
                if SavedArticleStorage.content(for: item.id) == nil {
                    item.status = .pending
                    item.failureReason = nil
                }
                merged.append(item)
            }
        }
        SavedArticleStorage.save(merged)
        reload()
        // Back up the union so links saved before sign-in (or via the Share
        // Extension) are captured too.
        try? await SavedArticleCloudSync.shared.save(articles, forEmail: email)
        await processPending()
    }

    /// Debounced push of the current list to iCloud after any change.
    private func pushToCloud() {
        guard let email = ownerEmail else { return }
        let snapshot = articles
        pushTask?.cancel()
        pushTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            try? await SavedArticleCloudSync.shared.save(snapshot, forEmail: email)
        }
    }

    var unreadCount: Int { articles.filter { !$0.isRead && $0.status == .ready }.count }

    /// Re-read the on-disk list (picks up items the Share Extension added while
    /// we were backgrounded), newest first.
    func reload() {
        articles = SavedArticleStorage.load().sorted { $0.addedAt > $1.addedAt }
    }

    /// Reload, then fetch/extract any pending (or previously failed) articles.
    func refresh() async {
        reload()
        await processPending()
    }

    func content(for id: SavedArticle.ID) -> String? {
        SavedArticleStorage.content(for: id)
    }

    /// Save pasted text as a ready-to-listen item (no fetch needed). The text is
    /// wrapped in minimal HTML paragraphs so the email parser reads it naturally.
    func addPastedText(title: String, text: String) {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }

        let id = UUID().uuidString
        let resolvedTitle = trimmedTitle.isEmpty
            ? String(body.prefix(60)).replacingOccurrences(of: "\n", with: " ")
            : trimmedTitle
        let html = body
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { "<p>\(Self.escapeHTML(String($0)))</p>" }
            .joined()

        let article = SavedArticle(
            id: id,
            url: URL(string: "voiceinbox://text/\(id)")!,
            title: resolvedTitle,
            siteName: "Pasted text",
            excerpt: String(body.prefix(140)),
            status: .ready
        )
        SavedArticleStorage.writeContent(html, for: id)
        articles.insert(article, at: 0)
        persist()
    }

    /// Save a link discovered while reading (e.g. a URL inside an email) into the
    /// Saved area, then fetch + extract it so it's ready to listen to offline.
    /// Returns false if that URL was already saved.
    @discardableResult
    func saveLink(_ url: URL, title: String? = nil) -> Bool {
        guard SavedArticleStorage.appendPending(url: url, title: title) != nil else { return false }
        reload()
        Task { await processPending() }
        return true
    }

    /// Whether a URL is already in the saved list (any status but failed).
    func isSaved(_ url: URL) -> Bool {
        articles.contains { $0.url == url && $0.status != .failed }
    }

    private static func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    func markRead(_ id: SavedArticle.ID, read: Bool = true) {
        guard let idx = articles.firstIndex(where: { $0.id == id }) else { return }
        articles[idx].isRead = read
        persist()
    }

    func delete(_ id: SavedArticle.ID) {
        articles.removeAll { $0.id == id }
        SavedArticleStorage.deleteContent(for: id)
        persist()
    }

    /// Re-attempt extraction for a failed item.
    func retry(_ id: SavedArticle.ID) async {
        guard let idx = articles.firstIndex(where: { $0.id == id }) else { return }
        articles[idx].status = .pending
        articles[idx].failureReason = nil
        persist()
        await processPending()
    }

    // MARK: - Processing

    private func processPending() async {
        guard !processing else { return }
        processing = true
        isProcessing = true
        defer { processing = false; isProcessing = false }

        // Snapshot the ids needing work so we don't fight list mutations.
        let pendingIDs = articles.filter { $0.status == .pending }.map(\.id)
        for id in pendingIDs {
            guard let article = articles.first(where: { $0.id == id }) else { continue }
            do {
                let result = try await ArticleExtractor.fetch(article.url)
                SavedArticleStorage.writeContent(result.html, for: id)
                update(id) {
                    $0.title = result.title
                    $0.siteName = result.siteName
                    $0.excerpt = result.excerpt
                    $0.status = .ready
                    $0.failureReason = nil
                }
            } catch {
                update(id) {
                    $0.status = .failed
                    $0.failureReason = error.localizedDescription
                }
            }
        }
    }

    private func update(_ id: SavedArticle.ID, _ mutate: (inout SavedArticle) -> Void) {
        guard let idx = articles.firstIndex(where: { $0.id == id }) else { return }
        mutate(&articles[idx])
        persist()
    }

    private func persist() {
        SavedArticleStorage.save(articles)
        pushToCloud()
    }
}
