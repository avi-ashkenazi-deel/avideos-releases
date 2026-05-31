import Foundation

/// Low-level, process-agnostic persistence for saved articles in the shared
/// app-group container. Used by BOTH the Share Extension (to append a pending
/// stub) and the main app's `SavedArticleStore` (to read, update, and cache
/// content). Deliberately plain/synchronous and free of UI dependencies so the
/// extension can link it without pulling in Combine/SwiftUI.
enum SavedArticleStorage {

    private static var listURL: URL {
        AppGroup.containerURL.appendingPathComponent("saved-articles.json")
    }

    private static var contentDir: URL {
        let dir = AppGroup.containerURL.appendingPathComponent("SavedArticles", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func contentURL(for id: String) -> URL {
        contentDir.appendingPathComponent("\(id).html")
    }

    // MARK: - List

    static func load() -> [SavedArticle] {
        guard let data = try? Data(contentsOf: listURL),
              let decoded = try? JSONDecoder.iso.decode([SavedArticle].self, from: data) else {
            return []
        }
        return decoded
    }

    static func save(_ articles: [SavedArticle]) {
        guard let data = try? JSONEncoder.iso.encode(articles) else { return }
        try? data.write(to: listURL, options: .atomic)
    }

    /// Append a freshly shared URL as a `pending` stub. Safe to call from the
    /// Share Extension. Dedupes by URL so re-sharing the same page is a no-op.
    @discardableResult
    static func appendPending(url: URL, title: String?) -> SavedArticle? {
        var articles = load()
        if articles.contains(where: { $0.url == url && $0.status != .failed }) {
            return nil
        }
        let article = SavedArticle(url: url, title: title)
        articles.insert(article, at: 0)
        save(articles)
        return article
    }

    // MARK: - Content

    static func content(for id: String) -> String? {
        try? String(contentsOf: contentURL(for: id), encoding: .utf8)
    }

    static func writeContent(_ html: String, for id: String) {
        try? html.data(using: .utf8)?.write(to: contentURL(for: id), options: .atomic)
    }

    static func deleteContent(for id: String) {
        try? FileManager.default.removeItem(at: contentURL(for: id))
    }
}
