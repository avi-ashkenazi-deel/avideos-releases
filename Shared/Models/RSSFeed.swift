import Foundation

/// An RSS/Atom feed the listener follows (like a lightweight Feedly).
struct RSSFeed: Identifiable, Codable, Hashable, Sendable {
    let id: String              // canonicalized feed URL
    var url: URL
    var title: String
    var siteURL: URL?
    var addedAt: Date
    /// Post a local notification when this feed gets new items.
    var notifyOnNewItems: Bool

    init(url: URL, title: String? = nil) {
        self.id = url.absoluteString.lowercased()
        self.url = url
        self.title = title ?? url.host ?? url.absoluteString
        self.siteURL = nil
        self.addedAt = Date()
        self.notifyOnNewItems = false
    }
}

/// One item/entry in a feed.
struct RSSItem: Identifiable, Codable, Hashable, Sendable {
    let id: String              // guid / atom id / link
    let feedID: String
    var title: String
    var link: URL?
    var summary: String?        // plain-ish text for the row
    var contentHTML: String?    // full content when the feed includes it
    var publishedAt: Date
    var isRead: Bool

    /// Build an `Email` so the existing parser/player pipeline can read it.
    /// Prefers the feed-supplied full content; falls back to the summary.
    func makeEmail(feedTitle: String, fullHTML: String? = nil) -> Email {
        Email(
            id: "rss-\(id)",
            threadId: "rss-\(id)",
            from: EmailAddress(name: feedTitle, address: link?.absoluteString ?? feedID),
            subject: title,
            snippet: summary ?? "",
            receivedAt: publishedAt,
            isRead: isRead,
            bodyHTML: fullHTML ?? contentHTML ?? summary,
            bodyText: nil
        )
    }
}
