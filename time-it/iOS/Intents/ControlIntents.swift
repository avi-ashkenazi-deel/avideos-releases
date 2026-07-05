import AppIntents
import Foundation

/// Voice / Action-Button control of the current timer. These act on the live
/// engine (the app is alive in the background while a timer runs), so they don't
/// need to open the app. If nothing is running, they're harmless no-ops.
struct PauseTimerIntent: AppIntent {
    static var title: LocalizedStringResource = "Pause Timer"
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        TimerControlCenter.shared.pauseCurrent()
        return .result(dialog: "Paused")
    }
}

struct ResumeTimerIntent: AppIntent {
    static var title: LocalizedStringResource = "Resume Timer"
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        TimerControlCenter.shared.resumeCurrent()
        return .result(dialog: "Resumed")
    }
}

struct StopCurrentTimerIntent: AppIntent {
    static var title: LocalizedStringResource = "Stop Timer"
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        TimerControlCenter.shared.stopAll()
        return .result(dialog: "Stopped")
    }
}

/// Start a one-minute rest. Opens the app so the rest runs with full audio /
/// haptics (via the same pending-handoff as starting a timer).
struct StartRestIntent: AppIntent {
    static var title: LocalizedStringResource = "Start a Rest"
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        PendingStart.setRest(seconds: 60)
        // If the app is already live, start it right away too.
        TimerControlCenter.shared.onStartRest?(60)
        return .result(dialog: "Starting a one-minute rest")
    }
}
