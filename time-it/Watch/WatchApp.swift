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
                .environmentObject(model.finishDetector)
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
    /// Watches a session for "looks finished" signals (idle / low HR).
    let finishDetector = SessionFinishDetector()
    private let announcer = SpeechAnnouncer()

    /// A freestyle "document the session" mode: the workout records as Functional
    /// Strength Training and you fire on-demand rests between sets.
    @Published var inSession = false
    private(set) var sessionStart: Date?
    /// Live heart rate during a session (from the workout), for display.
    @Published var heartRate: Double?

    init() {
        engine = TimerEngine(announcer: announcer)
    }

    func start() {
        SpeechAnnouncer.warmUp()   // load the voice catalog before the first cue
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

        settings.onRestsChange = { [weak self] rests in self?.bridge.syncRests(rests) }
        bridge.onRestsReceived = { [weak self] rests in self?.settings.applyRemoteRests(rests) }

        settings.onWorkoutKindChange = { [weak self] kind in self?.bridge.syncWorkoutKind(kind) }
        bridge.onWorkoutKindReceived = { [weak self] kind in self?.settings.applyRemoteWorkoutKind(kind) }

        presets.onLocalChange = { [weak self] list in self?.bridge.syncPresets(list) }
        bridge.onPresetsReceived = { [weak self] list in self?.presets.mergeFromRemote(list) }
        bridge.onStartCommand = { [weak self] id in
            guard let self, let preset = self.presets.presets.first(where: { $0.id == id }) else { return }
            self.startTimer(preset)
        }
        bridge.syncAll(presets: presets.presets, mode: settings.outputMode,
                       rests: settings.restDurations,
                       workoutKind: settings.sessionWorkoutKind)
    }

    /// Start a preset (one timer at a time). Exercise timers record a workout;
    /// others stay alive with silent audio (nothing logged). Each timer honors
    /// its own per-cue voice/haptic settings.
    func startTimer(_ preset: TimerPreset) {
        engine.stopAll()
        startKeepAlive(recordsWorkout: preset.isWorkout, kind: preset.workout)
        // Workout timers show live heart rate from the workout session, too.
        if preset.isWorkout {
            heartRate = nil
            keepAlive.onHeartRate = { [weak self] bpm in self?.heartRate = bpm }
        }
        engine.start(preset)
    }

    // MARK: Freestyle session (always a workout)

    func startSession() {
        sessionStart = Date()
        inSession = true
        heartRate = nil
        startKeepAlive(recordsWorkout: true, kind: settings.sessionWorkoutKind)
        keepAlive.onHeartRate = { [weak self] bpm in
            self?.finishDetector.updateHeartRate(bpm)
            self?.heartRate = bpm
        }
        finishDetector.startMonitoring()
    }

    func endSession() {
        HapticPlayer.play(.timeUp)        // strong buzz to mark the end
        engine.stopAll()
        inSession = false
        sessionStart = nil
        heartRate = nil
        finishDetector.stopMonitoring()
        keepAlive.onHeartRate = nil
        stopKeepAlive()
    }

    // MARK: Keep-alive selection

    private func startKeepAlive(recordsWorkout: Bool, kind: WorkoutKind = .functionalStrength) {
        AudioSession.activate()
        if recordsWorkout {
            audioKeepAlive.stop()
            keepAlive.startIfNeeded(kind: kind)
        } else {
            keepAlive.stop()
            audioKeepAlive.start()
        }
    }

    private func stopKeepAlive() {
        keepAlive.onHeartRate = nil
        heartRate = nil
        keepAlive.stop()
        audioKeepAlive.stop()
        AudioSession.deactivate()
    }

    /// Fire an on-demand rest countdown (e.g. after a max set). It counts down,
    /// speaks/buzzes the final seconds, and signals "go" at the end to bring you
    /// back. Returns to the session view when it finishes.
    func addRest(_ seconds: TimeInterval) {
        finishDetector.noteActivity()   // starting a rest means you're still going
        // Rests of a minute or more get a halfway tap (e.g. 1:00 into a 2:00 rest).
        let milestones: [TimerMilestone] = seconds >= 60
            ? [TimerMilestone(trigger: .percentElapsed(0.5), alert: .voiceAndHaptic,
                              haptic: .retry, label: "Halfway")]
            : []
        let rest = TimerPreset(
            name: "Rest",
            duration: seconds,
            intervals: nil,
            milestones: milestones,
            finalCountdown: FinalCountdown(lastSeconds: 5, haptic: true),
            colorHex: "#0A84FF"
        )
        engine.stopAll()
        engine.start(rest)
    }
}
