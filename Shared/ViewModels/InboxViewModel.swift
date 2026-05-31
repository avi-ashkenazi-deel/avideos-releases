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

    /// The next unread email to auto-advance to after finishing `id`. The inbox
    /// is newest-first, so we prefer the next unread *below* the finished one
    /// (older), then fall back to any other unread.
    func nextUnread(after id: String) -> Email? {
        if let idx = emails.firstIndex(where: { $0.id == id }),
           let next = emails[(idx + 1)...].first(where: { !$0.isRead }) {
            return next
        }
        return emails.first { !$0.isRead && $0.id != id }
    }

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

    /// Fill in "X min read" for emails we don't have a cached estimate for yet,
    /// by fetching bodies in small concurrent batches. Cached and persisted, so
    /// it's a one-time cost per message (and skips ones already known).
    func prefetchReadingTimes() async {
        let store = ReadingTimeStore.shared
        let missing = emails.map(\.id).filter { store.minutes(for: $0) == nil }
        guard !missing.isEmpty else { return }
        for start in stride(from: 0, to: missing.count, by: 4) {
            let batch = Array(missing[start..<min(start + 4, missing.count)])
            // Small pause between batches so this background backfill stays well
            // under Gmail's rate limit and doesn't compete with foreground loads.
            if start > 0 { try? await Task.sleep(nanoseconds: 300_000_000) }
            await withTaskGroup(of: (String, Int?).self) { group in
                for id in batch {
                    let service = mailService
                    group.addTask {
                        guard let full = try? await service.fetchFullEmail(id: id) else {
                            return (id, nil)
                        }
                        return (id, ReadingTime.minutes(for: full))
                    }
                }
                for await (id, minutes) in group {
                    if let minutes { store.record(id: id, minutes: minutes) }
                }
            }
        }
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
