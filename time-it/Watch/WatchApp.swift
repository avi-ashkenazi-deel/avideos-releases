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
                .environmentObject(model.settings)
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
    let settings = AppSettings()
    let bridge = ConnectivityBridge()
    /// Records a workout (keeps the app alive) for exercise timers/sessions.
    let keepAlive = WorkoutKeepAlive()
    /// Silent-audio keep-alive for non-exercise timers (no workout logged).
    private let audioKeepAlive = BackgroundKeepAlive()
    private let announcer = SpeechAnnouncer()

    /// A freestyle "document the session" mode: the workout records as Functional
    /// Strength Training and you fire on-demand rests between sets.
    @Published var inSession = false
    private(set) var sessionStart: Date?

    init() {
        engine = TimerEngine(announcer: announcer)
    }

    func start() {
        AudioSession.configureForAnnouncements()
        bridge.activate()
        engine.outputMode = settings.outputMode

        engine.onRunningSetChanged = { [weak self] isEmpty in
            guard let self else { return }
            // Stop the keep-alive(s) when nothing's running and no session is
            // open. Starting the right keep-alive happens in startTimer/Session,
            // which knows whether the timer is exercise.
            if isEmpty && !self.inSession {
                self.stopKeepAlive()
            } else {
                AudioSession.activate()
            }
        }

        settings.onChange = { [weak self] mode in
            self?.engine.outputMode = mode
            self?.bridge.syncOutputMode(mode)
        }
        bridge.onOutputModeReceived = { [weak self] mode in
            self?.settings.applyRemote(mode)
            self?.engine.outputMode = mode
        }

        presets.onLocalChange = { [weak self] list in self?.bridge.syncPresets(list) }
        bridge.onPresetsReceived = { [weak self] list in self?.presets.mergeFromRemote(list) }
        bridge.onStartCommand = { [weak self] id in
            guard let self, let preset = self.presets.presets.first(where: { $0.id == id }) else { return }
            self.startTimer(preset)
        }
        bridge.syncPresets(presets.presets)
        bridge.syncOutputMode(settings.outputMode)
    }

    /// Start a preset, applying its default output mode (if any) first. One timer
    /// at a time, so any current one is stopped. Exercise timers record a
    /// workout; others stay alive with silent audio (nothing logged).
    func startTimer(_ preset: TimerPreset) {
        if let mode = preset.defaultOutputMode { settings.outputMode = mode }
        engine.stopAll()
        startKeepAlive(recordsWorkout: preset.isWorkout)
        engine.start(preset)
    }

    // MARK: Freestyle session (always a workout)

    func startSession() {
        sessionStart = Date()
        inSession = true
        startKeepAlive(recordsWorkout: true)
    }

    func endSession() {
        engine.stopAll()
        inSession = false
        sessionStart = nil
        stopKeepAlive()
    }

    // MARK: Keep-alive selection

    private func startKeepAlive(recordsWorkout: Bool) {
        AudioSession.activate()
        if recordsWorkout {
            audioKeepAlive.stop()
            keepAlive.startIfNeeded()
        } else {
            keepAlive.stop()
            audioKeepAlive.start()
        }
    }

    private func stopKeepAlive() {
        keepAlive.stop()
        audioKeepAlive.stop()
        AudioSession.deactivate()
    }

    /// Fire an on-demand rest countdown (e.g. after a max set). It counts down,
    /// speaks/buzzes the final seconds, and signals "go" at the end to bring you
    /// back. Returns to the session view when it finishes.
    func addRest(_ seconds: TimeInterval) {
        let rest = TimerPreset(
            name: "Rest",
            duration: seconds,
            intervals: nil,
            milestones: [],
            finalCountdown: FinalCountdown(lastSeconds: 5, haptic: true),
            colorHex: "#0A84FF"
        )
        engine.stopAll()
        engine.start(rest)
    }
}
