import Foundation

/// A connected mail account.
struct MailAccount: Codable, Hashable, Sendable {
    enum Provider: String, Codable, Sendable {
        case google
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

/// Abstraction over an email backend so the UI doesn't care whether it's talking
/// to the real Gmail API or local mock data. Swap implementations in `AppState`.
protocol MailService: Sendable {
    /// The account currently signed in, if any.
    var account: MailAccount? { get async }

    /// Fetch the most recent messages in the inbox, newest first.
    func fetchInbox(limit: Int) async throws -> [Email]

    /// Fetch the full body for a message (mock returns it inline; Gmail fetches
    /// the full payload on demand).
    func fetchFullEmail(id: String) async throws -> Email

    /// Mark a message as read on the server (removes Gmail's UNREAD label).
    func markRead(id: String) async throws
}
