import Foundation
import Combine

/// Loads and tracks the inbox list.
@MainActor
final class InboxViewModel: ObservableObject {

    @Published private(set) var emails: [Email] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published var errorMessage: String?
    /// Folders/labels available to listen to, for the picker.
    @Published private(set) var labels: [MailLabel] = []
    /// Current search text ("" = browsing the selected folder).
    @Published var searchText = ""

    private var mailService: MailService
    private let settings: AppSettings
    private var nextPageToken: String?
    private let pageSize = 50
    /// The folder the last `load()` targeted — used to tell a folder switch
    /// (paint from cache first) apart from a same-folder refresh (don't).
    private var lastLoadedLabelId: String?

    private var searchQuery: String? {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    init(mailService: MailService, settings: AppSettings = .shared) {
        self.mailService = mailService
        self.settings = settings
    }

    var selectedLabelName: String { settings.mailLabelName }
    var selectedLabelId: String { settings.mailLabelId }

    /// Load the folder list (Inbox, categories, user labels), filtered + sorted.
    func loadLabels() async {
        guard let fetched = try? await mailService.fetchLabels() else { return }
        labels = fetched
            .filter { $0.isListenable }
            .sorted { ($0.sortRank, $0.displayName) < ($1.sortRank, $1.displayName) }
    }

    /// Switch the folder being listened to and reload.
    func selectLabel(_ label: MailLabel) async {
        settings.mailLabelId = label.id
        settings.mailLabelName = label.displayName
        await load()
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
        nextPageToken = nil
        defer { isLoading = false }
        // Cache-first: paint the folder's last-synced listing immediately (cold
        // launch and folder switches showed a spinner while Gmail round-tripped
        // ~50 metadata fetches). The live result replaces it when it lands; if
        // the network fails, the cached list simply stays on screen. Skipped on
        // pull-to-refresh of the same folder (the shown list is already newer
        // than or equal to the cache — repainting would just flicker).
        let requestedLabel = settings.mailLabelId
        if searchQuery == nil, emails.isEmpty || lastLoadedLabelId != requestedLabel,
           let caching = mailService as? CachingMailService {
            let cached = await caching.cachedInbox(labelId: requestedLabel)
            if !cached.isEmpty, settings.mailLabelId == requestedLabel {
                emails = cached
            }
        }
        lastLoadedLabelId = requestedLabel
        do {
            let page = try await mailService.fetchInbox(
                labelId: settings.mailLabelId, query: searchQuery, pageToken: nil, limit: pageSize)
            emails = page.emails
            nextPageToken = page.nextPageToken
        } catch {
            errorMessage = error.localizedDescription
        }
        await prefetchReadingTimes()
    }

    /// Load the next page (infinite scroll) until the whole folder/search is in.
    func loadMore() async {
        guard !isLoading, !isLoadingMore, let token = nextPageToken else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await mailService.fetchInbox(
                labelId: settings.mailLabelId, query: searchQuery, pageToken: token, limit: pageSize)
            let known = Set(emails.map(\.id))
            emails.append(contentsOf: page.emails.filter { !known.contains($0.id) })
            nextPageToken = page.nextPageToken
        } catch {
            errorMessage = error.localizedDescription
        }
        await prefetchReadingTimes()
    }

    /// Apply a new search query (or clear it) and reload from the top.
    func runSearch(_ text: String) async {
        searchText = text
        await load()
    }

    var hasMore: Bool { nextPageToken != nil }

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
        // Cap how many full bodies we pull per load. This backfill fetches an
        // entire email body just to estimate minutes; doing it for a whole inbox
        // burns Gmail quota and can trigger 429s that make the *foreground* sync
        // fail. The visible top of the list is what matters; the rest fill in as
        // they're opened or on later loads.
        let missing = Array(emails.map(\.id).filter { store.minutes(for: $0) == nil }.prefix(20))
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
