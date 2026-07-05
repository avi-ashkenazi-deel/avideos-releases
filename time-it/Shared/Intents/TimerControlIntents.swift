import AppIntents
import Foundation

/// Routes Live Activity button taps to the running engine. The app sets these
/// handlers at launch; the widget only references the intent types. This works
/// while a timer is showing because the audio keep-alive keeps the app process
/// alive in the background, so the intent runs in-process against the live engine.
@MainActor
final class TimerControlCenter {
    static let shared = TimerControlCenter()

    var onPauseResume: ((UUID) -> Void)?
    var onSkip: ((UUID) -> Void)?
    var onStop: ((UUID) -> Void)?

    private func id(_ s: String) -> UUID? { UUID(uuidString: s) }
    func pauseResume(_ s: String) { if let u = id(s) { onPauseResume?(u) } }
    func skip(_ s: String) { if let u = id(s) { onSkip?(u) } }
    func stop(_ s: String) { if let u = id(s) { onStop?(u) } }
}

/// Pause a running timer, or resume a paused one — from the Lock Screen /
/// Dynamic Island, without opening the app.
struct PauseResumeTimerIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Pause or Resume Timer"

    @Parameter(title: "Timer") var timerID: String

    init() {}
    init(timerID: String) { self.timerID = timerID }

    @MainActor
    func perform() async throws -> some IntentResult {
        TimerControlCenter.shared.pauseResume(timerID)
        return .result()
    }
}

/// Skip to the next interval of the running timer.
struct SkipIntervalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Skip Interval"

    @Parameter(title: "Timer") var timerID: String

    init() {}
    init(timerID: String) { self.timerID = timerID }

    @MainActor
    func perform() async throws -> some IntentResult {
        TimerControlCenter.shared.skip(timerID)
        return .result()
    }
}

/// Stop the running timer.
struct StopTimerIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop Timer"

    @Parameter(title: "Timer") var timerID: String

    init() {}
    init(timerID: String) { self.timerID = timerID }

    @MainActor
    func perform() async throws -> some IntentResult {
        TimerControlCenter.shared.stop(timerID)
        return .result()
    }
}
