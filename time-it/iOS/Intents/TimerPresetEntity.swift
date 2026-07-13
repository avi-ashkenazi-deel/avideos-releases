import AppIntents

/// A Siri/Shortcuts-visible reference to one saved timer. Backed by the preset
/// library in the App Group, so it resolves even when the app isn't running.
@available(iOS 16.0, *)
struct TimerPresetEntity: AppEntity {
    let id: String       // the preset's UUID string
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Timer"

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    static var defaultQuery = TimerPresetQuery()
}

/// Supplies Siri the list of timers (and resolves one by id). Reads the shared
/// library directly — no running app required.
@available(iOS 16.0, *)
struct TimerPresetQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [TimerPresetEntity] {
        Self.all.filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [TimerPresetEntity] {
        Self.all
    }

    func defaultResult() async -> TimerPresetEntity? {
        Self.all.first
    }

    private static var all: [TimerPresetEntity] {
        PresetStore.loadShared().map { TimerPresetEntity(id: $0.id.uuidString, name: $0.displayName) }
    }
}
