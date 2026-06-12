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
                .environmentObject(model.settings)
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
    let settings = AppSettings()
    let bridge = ConnectivityBridge()
    private let announcer = SpeechAnnouncer()
    private let notifications = NotificationScheduler()
    private let keepAlive = BackgroundKeepAlive()
    #if canImport(ActivityKit)
    private let liveActivity = LiveActivityController()
    #endif

    init() {
        engine = TimerEngine(announcer: announcer)
    }

    func start() {
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

        // Local preset edits → push to the watch.
        presets.onLocalChange = { [weak self] list in self?.bridge.syncPresets(list) }
        // Remote library / start commands from the watch.
        bridge.onPresetsReceived = { [weak self] list in self?.presets.mergeFromRemote(list) }
        bridge.onStartCommand = { [weak self] id in
            guard let self, let preset = self.presets.presets.first(where: { $0.id == id }) else { return }
            self.startTimer(preset)
        }
        // Send the current library + mode so a freshly-installed watch catches up.
        bridge.syncPresets(presets.presets)
        bridge.syncOutputMode(settings.outputMode)
    }

    /// Start a preset, applying its default output mode (if any) first. Only one
    /// timer runs at a time, so any current timer is stopped first.
    func startTimer(_ preset: TimerPreset) {
        if let mode = preset.defaultOutputMode { settings.outputMode = mode }
        engine.stopAll()
        engine.start(preset)
    }
}
