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

        // MARK: Current interval (the segment in progress)
        /// Whether this timer has more than one interval — when true the hero is
        /// the interval countdown and the total is shown secondary.
        var hasIntervals: Bool = false
        /// Start / end of the interval currently in progress (drives its own
        /// `Text(timerInterval:)` and `ProgressView(timerInterval:)`).
        var intervalStartDate: Date = .distantPast
        var intervalEndDate: Date = .distantFuture
        /// Frozen interval remaining, for the paused display.
        var intervalPausedRemaining: TimeInterval = 0
        /// Label for the interval in progress ("Work", "Rest", "Interval 2/8").
        var intervalLabel: String?
    }

    /// Stable per running timer so the app can find the right activity to update.
    var timerID: String
}
#endif
