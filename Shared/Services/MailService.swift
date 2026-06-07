import Foundation

/// A connected mail account.
struct MailAccount: Codable, Hashable, Sendable {
    enum Provider: String, Codable, Sendable {
        case google
        case microsoft
        case demo
    }

    var provider: Provider
    var emailAddress: String
    var displayName: String
}

enum MailServiceError: LocalizedError {
    case notAuthenticated
    case network(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "You're not signed in."
        case .network(let m): return "Network error: \(m)"
        case .decoding(let m): return "Couldn't read the server response: \(m)"
        }
    }
}

/// One page of messages plus the token to fetch the next page (nil when there
/// are no more), so the inbox can load everything by scrolling.
struct EmailPage: Sendable {
    let emails: [Email]
    let nextPageToken: String?
}

/// Abstraction over an email backend so the UI doesn't care whether it's talking
/// to the real Gmail API or local mock data. Swap implementations in `AppState`.
protocol MailService: Sendable {
    /// The account currently signed in, if any.
    var account: MailAccount? { get async }

    /// Fetch a page of messages for a label/folder (or a search `query`), newest
    /// first. Pass the previous page's `nextPageToken` to continue.
    func fetchInbox(labelId: String, query: String?, pageToken: String?, limit: Int) async throws -> EmailPage

    /// The user's labels (folders + categories) for the folder picker.
    func fetchLabels() async throws -> [MailLabel]

    /// Fetch the full body for a message (mock returns it inline; Gmail fetches
    /// the full payload on demand).
    func fetchFullEmail(id: String) async throws -> Email

    /// Mark a message as read on the server (removes Gmail's UNREAD label).
    func markRead(id: String) async throws

    /// Mark a message as unread on the server (adds Gmail's UNREAD label).
    func markUnread(id: String) async throws
}
