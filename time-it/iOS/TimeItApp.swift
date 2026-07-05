import SwiftUI

@main
struct TimeItApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.engine)
                .environmentObject(model.presets)
                .environmentObject(model.settings)
                .task { model.start() }
                // Siri ("start my … in Time It") opens the app; start the
                // requested timer once we're active.
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.startPendingIfNeeded() }
                }
        }
    }
}

/// Wires the shared engine, preset library, speech and connectivity together for
/// the iPhone. Owns app-wide objects so views can pull them from the environment.
@MainActor
final class AppModel: ObservableObject {
    let engine: TimerEngine
    let presets = PresetStore()
    let settings = AppSettings()
    let bridge = ConnectivityBridge()
    private let announcer = SpeechAnnouncer()
    private let notifications = NotificationScheduler()
    private let keepAlive = BackgroundKeepAlive()
    #if canImport(ActivityKit)
    private let liveActivity = LiveActivityController()
    #endif

    /// Freestyle session (count-up + on-demand rests), same as the watch.
    @Published var inSession = false
    private(set) var sessionStart: Date?

    init() {
        engine = TimerEngine(announcer: announcer)
    }

    func start() {
        SpeechAnnouncer.warmUp()   // load the voice catalog before the first cue
        AudioSession.configureForAnnouncements()
        bridge.activate()
        engine.outputMode = settings.outputMode

        // Background delivery: request permission and prepare the delegate.
        notifications.configure()
        notifications.requestAuthorization()

        // While timers run, keep a silent audio loop playing so the app stays
        // alive in the background and spoken/haptic cues fire live (not just the
        // fallback notifications). Stop it — and release the session — when idle.
        engine.onRunningSetChanged = { [weak self] isEmpty in
            guard let self else { return }
            if isEmpty {
                self.keepAlive.stop()
                AudioSession.deactivate()
            } else {
                AudioSession.activate()
                self.keepAlive.start()
            }
        }

        // On any discrete schedule change: refresh the Dynamic Island Live
        // Activities and re-schedule background notifications so cues still fire
        // when the app is suspended.
        engine.onTimersChanged = { [weak self] running in
            guard let self else { return }
            #if canImport(ActivityKit)
            self.liveActivity.sync(running)
            #endif
            self.notifications.reschedule(for: running)
        }

        // Each interval/milestone cue: refresh the Live Activity so the Dynamic
        // Island's "next" interval keeps up (no notification churn).
        engine.onCueFired = { [weak self] running in
            #if canImport(ActivityKit)
            self?.liveActivity.sync(running)
            #endif
        }

        // Output mode: local toggle → engine + watch; remote → engine + UI.
        settings.onChange = { [weak self] mode in
            self?.engine.outputMode = mode
            self?.bridge.syncOutputMode(mode)
        }
        bridge.onOutputModeReceived = { [weak self] mode in
            self?.settings.applyRemote(mode)
            self?.engine.outputMode = mode
        }

        // Rest-slot durations: local edits → watch; remote → UI.
        settings.onRestsChange = { [weak self] rests in self?.bridge.syncRests(rests) }
        bridge.onRestsReceived = { [weak self] rests in self?.settings.applyRemoteRests(rests) }

        // Free-workout activity type: local edits → watch; remote → UI.
        settings.onWorkoutKindChange = { [weak self] kind in self?.bridge.syncWorkoutKind(kind) }
        bridge.onWorkoutKindReceived = { [weak self] kind in self?.settings.applyRemoteWorkoutKind(kind) }

        // Local preset edits → push to the watch.
        presets.onLocalChange = { [weak self] list in self?.bridge.syncPresets(list) }
        // Remote library / start commands from the watch.
        bridge.onPresetsReceived = { [weak self] list in self?.presets.mergeFromRemote(list) }
        bridge.onStartCommand = { [weak self] id in
            guard let self, let preset = self.presets.presets.first(where: { $0.id == id }) else { return }
            self.startTimer(preset)
        }
        // Send the current library + settings so a fresh watch catches up —
        // one batched transmission, not four.
        bridge.syncAll(presets: presets.presets, mode: settings.outputMode,
                       rests: settings.restDurations,
                       workoutKind: settings.sessionWorkoutKind)

        // Keep Siri's timer names current after any library change (local or
        // synced from the watch), and once now.
        let refreshSiri: () -> Void = { if #available(iOS 16.0, *) { TimeItShortcuts.updateAppShortcutParameters() } }
        let priorLocal = presets.onLocalChange
        presets.onLocalChange = { list in priorLocal?(list); refreshSiri() }
        let priorRemote = bridge.onPresetsReceived
        bridge.onPresetsReceived = { list in priorRemote?(list); refreshSiri() }
        refreshSiri()

        // A timer requested by Siri before launch: start it now.
        startPendingIfNeeded()
    }

    /// If Siri (or a Shortcut) asked to start a timer, start it once.
    func startPendingIfNeeded() {
        guard let id = PendingStart.take(),
              let preset = presets.presets.first(where: { $0.id == id }) else { return }
        startTimer(preset)
    }

    /// Start a preset. Only one timer runs at a time, so any current one is
    /// stopped first. Each timer honors its own per-cue voice/haptic settings.
    func startTimer(_ preset: TimerPreset) {
        engine.stopAll()
        engine.start(preset)
    }

    // MARK: Freestyle session (iPhone — count-up + on-demand rests, no workout)

    func startSession() {
        sessionStart = Date()
        inSession = true
    }

    func endSession() {
        HapticPlayer.play(.timeUp)        // strong buzz to mark the end
        engine.stopAll()
        inSession = false
        sessionStart = nil
    }

    /// Fire an on-demand rest countdown; returns to the session when it finishes.
    func addRest(_ seconds: TimeInterval) {
        // Rests of a minute or more get a halfway tap (e.g. 1:00 into a 2:00 rest).
        let milestones: [TimerMilestone] = seconds >= 60
            ? [TimerMilestone(trigger: .percentElapsed(0.5), alert: .voiceAndHaptic,
                              haptic: .retry, label: "Halfway")]
            : []
        let rest = TimerPreset(
            name: "Rest", duration: seconds, intervals: nil, milestones: milestones,
            finalCountdown: FinalCountdown(lastSeconds: 5, haptic: true),
            colorHex: "#0A84FF"
        )
        engine.stopAll()
        engine.start(rest)
    }
}
