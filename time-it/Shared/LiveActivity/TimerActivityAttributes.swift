import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// Shared between the app (which starts/updates the activity) and the widget
/// extension (which renders it on the Lock Screen and in the Dynamic Island).
///
/// The `ContentState` carries an absolute `endDate` so the widget can drive its
/// own countdown with `Text(timerInterval:)` / `ProgressView(timerInterval:)` —
/// no push updates needed every second.
struct TimerActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var name: String
        /// Start of the current run (for the progress bar's lower bound).
        var startDate: Date
        /// When the run will complete if it keeps running.
        var endDate: Date
        var isRunning: Bool
        /// Frozen remaining time, used to display a paused timer (no live count).
        var pausedRemaining: TimeInterval
        var colorHex: String
        var nextCueLabel: String?
    }

    /// Stable per running timer so the app can find the right activity to update.
    var timerID: String
}
#endif
