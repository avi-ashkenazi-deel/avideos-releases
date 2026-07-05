import AppIntents
import Foundation

/// "Hey Siri, start my Tabata in Time It." Hands the chosen timer to the app via
/// the App Group and opens it, so the timer runs with full voice, haptics, and
/// Live Activity (all of which want the app foregrounded).
@available(iOS 16.0, *)
struct StartTimerIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Timer"
    static var description = IntentDescription("Starts one of your Time It timers.")

    /// Open Time It when Siri/Shortcuts runs this.
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Timer")
    var preset: TimerPresetEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Start \(\.$preset)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        PendingStart.set(presetID: preset.id)
        return .result(dialog: "Starting \(preset.name)")
    }
}

/// Cross-process handoff for a Siri-requested start: the intent writes the
/// pending preset id + a timestamp; the app reads it on launch / when it becomes
/// active, starts that timer once, and clears it.
enum PendingStart {
    private static let idKey = "pendingStartPresetID"
    private static let stampKey = "pendingStartStamp"
    /// Ignore requests older than this (stale — app opened later for other reasons).
    private static let maxAge: TimeInterval = 30

    static func set(presetID: String) {
        let d = AppGroup.sharedDefaults
        d.set(presetID, forKey: idKey)
        d.set(Date().timeIntervalSince1970, forKey: stampKey)
    }

    /// Consume a fresh pending id, if any (also clears it). Returns nil when
    /// there's nothing pending or it's too old.
    static func take(now: Date = Date()) -> UUID? {
        let d = AppGroup.sharedDefaults
        guard let idString = d.string(forKey: idKey) else { return nil }
        let stamp = d.double(forKey: stampKey)
        d.removeObject(forKey: idKey)
        d.removeObject(forKey: stampKey)
        guard now.timeIntervalSince1970 - stamp < maxAge else { return nil }
        return UUID(uuidString: idString)
    }
}
