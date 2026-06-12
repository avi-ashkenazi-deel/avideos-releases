import SwiftUI

@main
struct TimeItWatchApp: App {
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            NavigationStack { WatchRootView() }
                .environmentObject(model)
                .environmentObject(model.engine)
                .environmentObject(model.presets)
                .task { model.start() }
        }
    }
}

/// Watch-side wiring. The watch runs its **own** `TimerEngine` (independent from
/// the phone) and keeps itself alive with an `HKWorkoutSession` while timers run,
/// so haptics fire on time even with the wrist down during a talk.
@MainActor
final class WatchModel: ObservableObject {
    let engine: TimerEngine
    let presets = PresetStore()
    let bridge = ConnectivityBridge()
    let keepAlive = WorkoutKeepAlive()
    private let announcer = SpeechAnnouncer()

    init() {
        engine = TimerEngine(announcer: announcer)
    }

    func start() {
        AudioSession.configureForAnnouncements()
        bridge.activate()

        engine.onRunningSetChanged = { [weak self] isEmpty in
            guard let self else { return }
            if isEmpty {
                self.keepAlive.stop()
                AudioSession.deactivate()
            } else {
                self.keepAlive.startIfNeeded()
                AudioSession.activate()
            }
        }

        presets.onLocalChange = { [weak self] list in self?.bridge.syncPresets(list) }
        bridge.onPresetsReceived = { [weak self] list in self?.presets.mergeFromRemote(list) }
        bridge.onStartCommand = { [weak self] id in
            guard let self, let preset = self.presets.presets.first(where: { $0.id == id }) else { return }
            self.engine.start(preset)
        }
        bridge.syncPresets(presets.presets)
    }
}
