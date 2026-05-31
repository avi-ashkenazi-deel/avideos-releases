import Foundation
import Combine

/// Persists highlights to a JSON file in the shared app-group container so the
/// phone and watch see the same set.
@MainActor
final class HighlightStore: ObservableObject {

    static let shared = HighlightStore()

    @Published private(set) var highlights: [Highlight] = []

    private let fileURL: URL

    init(appGroup: String = AppGroup.identifier) {
        let base = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.fileURL = base.appendingPathComponent("highlights.json")
        load()
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
    }
}
