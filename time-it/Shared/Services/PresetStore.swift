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

    /// Reorder the library (drag-and-drop on the list).
    func move(from offsets: IndexSet, to destination: Int) {
        presets.move(fromOffsets: offsets, toOffset: destination)
        persistAndBroadcast()
    }

    /// Replace the whole library from a remote sync (does NOT re-broadcast).
    /// No-op when identical — the other device re-pushes its context on every
    /// launch, and an unchanged library shouldn't re-render lists or hit disk.
    func mergeFromRemote(_ remote: [TimerPreset]) {
        guard remote != presets else { return }
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

    /// Read the saved library straight from the App Group without a store
    /// instance — used by App Intents / Siri, which run outside the main actor
    /// (and often outside the app's process). `nonisolated` + self-contained so
    /// it can be called from anywhere.
    nonisolated static func loadShared() -> [TimerPreset] {
        let url = AppGroup.containerURL.appendingPathComponent("presets.json")
        guard let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode([TimerPreset].self, from: data)
        else { return TimerPreset.samples }
        return list
    }
}
