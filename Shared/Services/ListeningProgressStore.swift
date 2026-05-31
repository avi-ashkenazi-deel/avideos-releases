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
@MainActor
final class ListeningProgressStore: ObservableObject {

    static let shared = ListeningProgressStore()

    @Published private(set) var byID: [String: ListeningProgress] = [:]

    private let fileURL: URL

    init(containerURL: URL = AppGroup.containerURL) {
        self.fileURL = containerURL.appendingPathComponent("listening-progress.json")
        load()
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
    }
}
