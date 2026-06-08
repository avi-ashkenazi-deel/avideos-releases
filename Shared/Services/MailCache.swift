import Foundation

/// On-disk cache of a mailbox so the app works offline: the folder listings, the
/// most recent full message bodies, the label list, and the account profile. One
/// JSON file per account, in the shared app-group container.
actor MailCache {
    private struct Snapshot: Codable {
        var account: MailAccount?
        var labels: [MailLabel] = []
        /// Folder/label id → the cached list for that folder (newest first).
        var listings: [String: [Email]] = [:]
        /// Recently fetched full bodies, most-recent first (capped).
        var fullBodies: [Email] = []
    }

    /// How many listed messages and full bodies to keep per account.
    private let maxListed = 150
    private let maxBodies = 120

    private let dir: URL
    private let url: URL
    private var snapshot = Snapshot()
    private var loaded = false

    init(accountID: String) {
        dir = AppGroup.containerURL.appendingPathComponent("MailCache", isDirectory: true)
        // Keep the filename filesystem-safe regardless of the account id.
        let safe = accountID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "account"
        url = dir.appendingPathComponent("\(safe).json")
        // No file I/O here: init runs on the caller (often the main thread at
        // launch). The snapshot is loaded lazily on the actor's executor instead.
    }

    /// Read the file the first time the cache is touched (on the actor's executor,
    /// off the main thread), so a large cache never hitches launch.
    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        if let data = try? Data(contentsOf: url),
           let snap = try? JSONDecoder.iso.decode(Snapshot.self, from: data) {
            snapshot = snap
        }
    }

    // MARK: Reads

    func account() -> MailAccount? { loadIfNeeded(); return snapshot.account }
    func labels() -> [MailLabel] { loadIfNeeded(); return snapshot.labels }
    func listing(label: String) -> [Email] { loadIfNeeded(); return snapshot.listings[label] ?? [] }
    func fullBody(id: String) -> Email? { loadIfNeeded(); return snapshot.fullBodies.first { $0.id == id } }

    // MARK: Writes

    func store(account: MailAccount) {
        loadIfNeeded()
        snapshot.account = account
        persist()
    }

    func store(labels: [MailLabel]) {
        loadIfNeeded()
        snapshot.labels = labels
        persist()
    }

    /// Replace (first page) or append (subsequent pages) a folder's cached list.
    func store(listing emails: [Email], label: String, replace: Bool) {
        loadIfNeeded()
        if replace {
            snapshot.listings[label] = Array(emails.prefix(maxListed))
        } else {
            var existing = snapshot.listings[label] ?? []
            let known = Set(existing.map(\.id))
            existing.append(contentsOf: emails.filter { !known.contains($0.id) })
            snapshot.listings[label] = Array(existing.prefix(maxListed))
        }
        persist()
    }

    func store(fullBody email: Email) {
        loadIfNeeded()
        snapshot.fullBodies.removeAll { $0.id == email.id }
        snapshot.fullBodies.insert(email, at: 0)
        if snapshot.fullBodies.count > maxBodies {
            snapshot.fullBodies.removeLast(snapshot.fullBodies.count - maxBodies)
        }
        persist()
    }

    private func persist() {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder.iso.encode(snapshot) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

/// Wraps a real `MailService` with an offline cache. Online, it passes through and
/// records results; offline (or on failure), it serves the last cached copy so the
/// inbox still lists, opens, and auto-advances without a connection.
final class CachingMailService: MailService {
    private let base: MailService
    private let cache: MailCache

    init(base: MailService, accountID: String) {
        self.base = base
        self.cache = MailCache(accountID: accountID)
    }

    private var isOnline: Bool { NetworkMonitor.shared.isOnline }

    var account: MailAccount? {
        get async {
            if isOnline, let live = await base.account, !live.emailAddress.isEmpty {
                await cache.store(account: live)
                return live
            }
            return await cache.account()
        }
    }

    func fetchInbox(labelId: String, query: String?, pageToken: String?, limit: Int) async throws -> EmailPage {
        // Search needs the server; only cache plain folder browsing.
        let cacheable = query == nil

        func cached() async -> EmailPage? {
            guard cacheable, pageToken == nil else { return nil }
            let list = await cache.listing(label: labelId)
            return list.isEmpty ? nil : EmailPage(emails: list, nextPageToken: nil)
        }

        guard isOnline else {
            if let page = await cached() { return page }
            throw MailServiceError.network("You're offline and this folder isn't cached yet.")
        }
        do {
            let page = try await base.fetchInbox(labelId: labelId, query: query, pageToken: pageToken, limit: limit)
            if cacheable {
                await cache.store(listing: page.emails, label: labelId, replace: pageToken == nil)
            }
            return page
        } catch {
            if let page = await cached() { return page }
            throw error
        }
    }

    func fetchLabels() async throws -> [MailLabel] {
        guard isOnline else {
            let cached = await cache.labels()
            if !cached.isEmpty { return cached }
            throw MailServiceError.network("You're offline.")
        }
        do {
            let labels = try await base.fetchLabels()
            await cache.store(labels: labels)
            return labels
        } catch {
            let cached = await cache.labels()
            if !cached.isEmpty { return cached }
            throw error
        }
    }

    func fetchFullEmail(id: String) async throws -> Email {
        guard isOnline else {
            if let cached = await cache.fullBody(id: id) { return cached }
            throw MailServiceError.network("You're offline and this message isn't cached yet.")
        }
        do {
            let full = try await base.fetchFullEmail(id: id)
            await cache.store(fullBody: full)
            return full
        } catch {
            if let cached = await cache.fullBody(id: id) { return cached }
            throw error
        }
    }

    func markRead(id: String) async throws {
        try await base.markRead(id: id)
    }

    func markUnread(id: String) async throws {
        try await base.markUnread(id: id)
    }
}
