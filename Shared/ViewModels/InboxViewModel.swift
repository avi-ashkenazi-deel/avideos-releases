import Foundation
import Combine

/// Loads and tracks the inbox list.
@MainActor
final class InboxViewModel: ObservableObject {

    @Published private(set) var emails: [Email] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private var mailService: MailService

    init(mailService: MailService) {
        self.mailService = mailService
    }

    /// Rebind to the active backend (demo vs Google) once `AppState` knows it.
    func configure(_ service: MailService) {
        mailService = service
    }

    var unreadCount: Int { emails.filter { !$0.isRead }.count }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            emails = try await mailService.fetchInbox(limit: 50)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Reflect a just-finished email as read without a full reload.
    func markReadLocally(_ id: String) {
        guard let idx = emails.firstIndex(where: { $0.id == id }) else { return }
        emails[idx].isRead = true
    }

    /// Mark an email read on the server without opening/listening to it.
    func markRead(_ id: String) async {
        markReadLocally(id)
        do {
            try await mailService.markRead(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Mark an email unread on the server.
    func markUnread(_ id: String) async {
        if let idx = emails.firstIndex(where: { $0.id == id }) {
            emails[idx].isRead = false
        }
        do {
            try await mailService.markUnread(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
