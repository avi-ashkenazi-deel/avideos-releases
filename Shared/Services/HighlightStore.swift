import Foundation
import Combine

/// Persists highlights to a JSON file in the shared app-group container so the
/// phone and watch see the same set.
@MainActor
final class HighlightStore: ObservableObject {

    static let shared = HighlightStore()

    @Published private(set) var highlights: [Highlight] = []

    private let fileURL: URL
    private let cloud = NSUbiquitousKeyValueStore.default
    private static let cloudKey = "highlights"

    init(appGroup: String = AppGroup.identifier) {
        let base = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.fileURL = base.appendingPathComponent("highlights.json")
        load()
        // Highlights are mirrored to iCloud so notes survive deleting/reinstalling
        // the app and sync across devices.
        mergeFromCloud()
        NotificationCenter.default.addObserver(
            forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: cloud, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.mergeFromCloud() }
        }
        cloud.synchronize()
    }

    func add(_ highlight: Highlight) {
        // Idempotent by id so a highlight relayed from the watch isn't duplicated.
        guard !highlights.contains(where: { $0.id == highlight.id }) else { return }
        highlights.insert(highlight, at: 0)
        save()
    }

    func updateNote(for id: Highlight.ID, note: String) {
        guard let idx = highlights.firstIndex(where: { $0.id == id }) else { return }
        highlights[idx].note = note
        save()
    }

    func remove(_ id: Highlight.ID) {
        highlights.removeAll { $0.id == id }
        save()
    }

    func highlights(forEmail emailID: String) -> [Highlight] {
        highlights.filter { $0.emailID == emailID }
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder.iso.decode([Highlight].self, from: data) else {
            return
        }
        highlights = decoded.sorted { $0.createdAt > $1.createdAt }
    }

    private func save() {
        guard let data = try? JSONEncoder.iso.encode(highlights) else { return }
        try? data.write(to: fileURL, options: .atomic)
        cloud.set(data, forKey: Self.cloudKey)
    }

    /// Fold the iCloud copy into the local set: adopt any highlights we don't have
    /// (restores everything after a reinstall, when local is empty), and prefer a
    /// version that carries a note over a note-less duplicate.
    private func mergeFromCloud() {
        guard let data = cloud.data(forKey: Self.cloudKey),
              let remote = try? JSONDecoder.iso.decode([Highlight].self, from: data) else { return }
        var byID = Dictionary(highlights.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var changed = false
        for r in remote {
            if let local = byID[r.id] {
                if local.note.isEmpty, !r.note.isEmpty { byID[r.id] = r; changed = true }
            } else {
                byID[r.id] = r; changed = true
            }
        }
        guard changed else { return }
        highlights = byID.values.sorted { $0.createdAt > $1.createdAt }
        if let encoded = try? JSONEncoder.iso.encode(highlights) {
            try? encoded.write(to: fileURL, options: .atomic)
        }
    }
}
