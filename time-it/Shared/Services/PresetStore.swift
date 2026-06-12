import Foundation
import Combine

/// The user's library of timer presets, persisted as JSON in the App Group
/// container so the iPhone and Watch share the same set. Edits on either device
/// are written here and broadcast to the other via `ConnectivityBridge`.
@MainActor
final class PresetStore: ObservableObject {

    @Published private(set) var presets: [TimerPreset]

    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// Called after any local mutation so the host can sync to the other device.
    var onLocalChange: (([TimerPreset]) -> Void)?

    init() {
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        fileURL = AppGroup.containerURL.appendingPathComponent("presets.json")
        presets = Self.load(from: fileURL, decoder: decoder) ?? TimerPreset.samples
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            persist() // seed the samples on first launch
        }
    }

    // MARK: Mutations

    func add(_ preset: TimerPreset) {
        presets.append(preset)
        persistAndBroadcast()
    }

    func update(_ preset: TimerPreset) {
        guard let i = presets.firstIndex(where: { $0.id == preset.id }) else {
            add(preset); return
        }
        presets[i] = preset
        persistAndBroadcast()
    }

    func delete(at offsets: IndexSet) {
        presets.remove(atOffsets: offsets)
        persistAndBroadcast()
    }

    func delete(id: UUID) {
        presets.removeAll { $0.id == id }
        persistAndBroadcast()
    }

    /// Replace the whole library from a remote sync (does NOT re-broadcast).
    func mergeFromRemote(_ remote: [TimerPreset]) {
        presets = remote
        persist()
    }

    // MARK: Persistence

    private func persistAndBroadcast() {
        persist()
        onLocalChange?(presets)
    }

    private func persist() {
        do {
            let data = try encoder.encode(presets)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            #if DEBUG
            print("PresetStore persist failed: \(error)")
            #endif
        }
    }

    private static func load(from url: URL, decoder: JSONDecoder) -> [TimerPreset]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode([TimerPreset].self, from: data)
    }
}
