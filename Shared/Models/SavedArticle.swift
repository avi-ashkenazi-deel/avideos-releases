import Foundation

/// A web page saved from another app (Safari, Feedly, …) via the Share
/// Extension, to be read aloud and cached for offline listening.
///
/// The extension stores only a `pending` stub (the URL). The main app later
/// fetches the page, extracts the readable content, caches it, and flips the
/// status to `ready`. Playback reuses the email pipeline by synthesizing an
/// `Email` from the cached content (see `makeEmail`).
struct SavedArticle: Identifiable, Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable {
        case pending   // saved, not yet fetched/extracted
        case ready     // content cached, playable offline
        case failed    // fetch/extract failed
    }

    let id: String
    var url: URL
    var title: String
    var siteName: String?
    var excerpt: String?
    var addedAt: Date
    var status: Status
    var isRead: Bool
    var failureReason: String?

    init(id: String = UUID().uuidString,
         url: URL,
         title: String? = nil,
         siteName: String? = nil,
         excerpt: String? = nil,
         addedAt: Date = Date(),
         status: Status = .pending,
         isRead: Bool = false,
         failureReason: String? = nil) {
        self.id = id
        self.url = url
        // Until extraction runs, show the host as a placeholder title.
        self.title = title ?? url.host ?? url.absoluteString
        self.siteName = siteName
        self.excerpt = excerpt
        self.addedAt = addedAt
        self.status = status
        self.isRead = isRead
        self.failureReason = failureReason
    }

    var displayTitle: String { title.isEmpty ? (url.host ?? url.absoluteString) : title }

    /// Build an `Email` the existing player/parser can consume from cached HTML.
    func makeEmail(html: String) -> Email {
        Email(
            id: id,
            threadId: id,
            from: EmailAddress(name: siteName ?? url.host, address: url.absoluteString),
            subject: displayTitle,
            snippet: excerpt ?? "",
            receivedAt: addedAt,
            isRead: isRead,
            bodyHTML: html,
            bodyText: nil
        )
    }
}
