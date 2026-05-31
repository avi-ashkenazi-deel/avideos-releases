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

    private init() {
        reload()
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
    }
}
