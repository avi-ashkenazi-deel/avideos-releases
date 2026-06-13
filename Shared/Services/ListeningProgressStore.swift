import Foundation
import Combine

/// How far the listener got through a given email/article, persisted so the
/// inbox can show progress and the player can resume where they left off.
/// Keyed by the message/article id (the synthesized article id works too).
struct ListeningProgress: Codable, Sendable {
    var blockIndex: Int
    var blockCount: Int
    var isComplete: Bool
    var updatedAt: Date

    /// 0...1 share of the content reached.
    var fraction: Double {
        if isComplete { return 1 }
        guard blockCount > 1 else { return 0 }
        return min(max(Double(blockIndex) / Double(blockCount - 1), 0), 1)
    }
}

/// Persists per-message listening progress to a JSON file in the shared
/// app-group container (falls back to the local container when the group isn't
/// provisioned). Published so the inbox updates as you listen.
///
/// Progress is also mirrored to the iCloud key-value store so a message you
/// started on the iPhone resumes where you left off on the iPad and vice versa.
/// Conflicts are resolved per id by keeping whichever record was updated last.
/// If iCloud isn't available (no account, capability off, previews), everything
/// still works locally — the cloud mirror simply does nothing.
@MainActor
final class ListeningProgressStore: ObservableObject {

    static let shared = ListeningProgressStore()

    @Published private(set) var byID: [String: ListeningProgress] = [:]

    private let fileURL: URL
    private let cloud = NSUbiquitousKeyValueStore.default
    private static let cloudKey = "listening-progress"

    init(containerURL: URL = AppGroup.containerURL) {
        self.fileURL = containerURL.appendingPathComponent("listening-progress.json")
        load()
        // Fold in anything iCloud already knows, then keep listening for changes
        // pushed from the user's other devices.
        mergeFromCloud()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(cloudChangedExternally),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: cloud
        )
        cloud.synchronize()
    }

    func progress(for id: String) -> ListeningProgress? { byID[id] }

    func fraction(for id: String) -> Double { byID[id]?.fraction ?? 0 }

    func record(id: String, blockIndex: Int, blockCount: Int, isComplete: Bool) {
        byID[id] = ListeningProgress(
            blockIndex: blockIndex,
            blockCount: blockCount,
            isComplete: isComplete,
            updatedAt: Date()
        )
        save()
    }

    func clear(id: String) {
        byID[id] = nil
        save()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder.iso.decode([String: ListeningProgress].self, from: data) else {
            return
        }
        byID = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder.iso.encode(byID) else { return }
        try? data.write(to: fileURL, options: .atomic)
        // Mirror to iCloud for cross-device resume.
        cloud.set(data, forKey: Self.cloudKey)
    }

    // MARK: - iCloud sync

    @objc private func cloudChangedExternally(_ note: Notification) {
        // Fires on a background thread; hop to the main actor to touch state.
        Task { @MainActor in self.mergeFromCloud() }
    }

    /// Merge the iCloud copy into the local one, keeping the most recently
    /// updated record for each id. Writes back to disk if anything changed, but
    /// deliberately does *not* push back to iCloud (that would echo the change).
    private func mergeFromCloud() {
        guard let data = cloud.data(forKey: Self.cloudKey),
              let remote = try? JSONDecoder.iso.decode([String: ListeningProgress].self, from: data) else {
            return
        }
        var merged = byID
        var changed = false
        for (id, remoteValue) in remote {
            if let localValue = merged[id], localValue.updatedAt >= remoteValue.updatedAt {
                continue
            }
            merged[id] = remoteValue
            changed = true
        }
        guard changed else { return }
        byID = merged
        if let encoded = try? JSONEncoder.iso.encode(byID) {
            try? encoded.write(to: fileURL, options: .atomic)
        }
    }
}
