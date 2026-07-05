import Foundation

/// Inert mail backend used when no mailbox is connected. The app is fully usable
/// with just RSS feeds and Saved articles, so instead of a sign-in wall we run
/// this "empty" service: no account, no messages, no folders. The Inbox tab shows
/// a "connect your email" state (see `InboxList`), and connecting a mailbox swaps
/// in the real Google/Microsoft service.
actor NoMailService: MailService {
    var account: MailAccount? { nil }

    func fetchInbox(labelId: String, query: String?, pageToken: String?, limit: Int) async throws -> EmailPage {
        EmailPage(emails: [], nextPageToken: nil)
    }

    func fetchLabels() async throws -> [MailLabel] { [] }

    func fetchFullEmail(id: String) async throws -> Email {
        throw MailServiceError.notAuthenticated
    }

    func markRead(id: String) async throws {}
    func markUnread(id: String) async throws {}
}
