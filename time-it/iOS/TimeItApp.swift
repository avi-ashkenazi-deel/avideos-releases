import SwiftUI

@main
struct TimeItApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.engine)
                .environmentObject(model.presets)
                .task { model.start() }
        }
    }
}

/// Wires the shared engine, preset library, speech and connectivity together for
/// the iPhone. Owns app-wide objects so views can pull them from the environment.
@MainActor
final class AppModel: ObservableObject {
    let engine: TimerEngine
    let presets = PresetStore()
    let bridge = ConnectivityBridge()
    private let announcer = SpeechAnnouncer()

    init() {
        engine = TimerEngine(announcer: announcer)
    }

    func start() {
        AudioSession.configureForAnnouncements()
        bridge.activate()

        // Keep the audio session active only while timers run, so the user's
        // music returns to full volume when nothing's counting.
        engine.onRunningSetChanged = { isEmpty in
            if isEmpty { AudioSession.deactivate() } else { AudioSession.activate() }
        }

        // Local preset edits → push to the watch.
        presets.onLocalChange = { [weak self] list in self?.bridge.syncPresets(list) }
        // Remote library / start commands from the watch.
        bridge.onPresetsReceived = { [weak self] list in self?.presets.mergeFromRemote(list) }
        bridge.onStartCommand = { [weak self] id in
            guard let self, let preset = self.presets.presets.first(where: { $0.id == id }) else { return }
            self.engine.start(preset)
        }
        // Send the current library so a freshly-installed watch catches up.
        bridge.syncPresets(presets.presets)
    }
}
