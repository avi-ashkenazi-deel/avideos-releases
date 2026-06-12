import Foundation

/// The countdown to spoken in the final stretch of a timer, e.g. "10, 9, … 1".
struct FinalCountdown: Codable, Hashable {
    /// Speak each whole second for the last N seconds.
    var lastSeconds: Int = 10
    /// Whether the countdown also buzzes each second on the watch.
    var haptic: Bool = true
}

/// A reusable timer definition the user configures once and starts many times.
struct TimerPreset: Codable, Hashable, Identifiable {
    var id: UUID = UUID()
    var name: String
    /// Total length of one run, in seconds.
    var duration: TimeInterval
    var milestones: [TimerMilestone] = []
    var finalCountdown: FinalCountdown? = FinalCountdown()
    /// Hex string (e.g. "#FF9500") used to tint the timer in the UI.
    var colorHex: String = "#FF9500"
    /// How many times to run back-to-back (gym sets). 1 == single run.
    var repeatCount: Int = 1
    /// When set, starting this preset switches the app's master output mode to
    /// this value — e.g. a "Talk" preset that always goes silent/vibrate. `nil`
    /// leaves the current mode untouched.
    var defaultOutputMode: OutputMode? = nil

    /// Milestones sorted by the order they fire during a run.
    func sortedMilestones() -> [TimerMilestone] {
        milestones.sorted { $0.trigger.fireTime(forDuration: duration) < $1.trigger.fireTime(forDuration: duration) }
    }

    // MARK: Sample content

    /// Two ready-made presets covering the two driving use cases.
    static let samples: [TimerPreset] = [gymInterval, conferenceTalk]

    /// Gym: a 60s interval that speaks the cadence and counts down the last 10s.
    static var gymInterval: TimerPreset {
        TimerPreset(
            name: "Gym interval",
            duration: 60,
            milestones: [
                TimerMilestone(trigger: .percentElapsed(0.5), alert: .voice, label: "Halfway"),
                TimerMilestone(trigger: .secondsRemaining(20), alert: .voiceAndHaptic,
                               haptic: .retry, label: "20 seconds"),
            ],
            finalCountdown: FinalCountdown(lastSeconds: 10, haptic: true),
            colorHex: "#FF9500",
            repeatCount: 1,
            defaultOutputMode: .voiceOnly
        )
    }

    /// Conference talk: a 20-minute talk, haptic-only so it's silent on stage.
    static var conferenceTalk: TimerPreset {
        TimerPreset(
            name: "20 min talk",
            duration: 20 * 60,
            milestones: [
                TimerMilestone(trigger: .percentElapsed(0.5), alert: .haptic,
                               haptic: .directionUp, label: "Halftime"),
                TimerMilestone(trigger: .secondsRemaining(5 * 60), alert: .haptic,
                               haptic: .retry, label: "5 minutes left"),
                TimerMilestone(trigger: .secondsRemaining(60), alert: .haptic,
                               haptic: .stop, label: "Wrap up"),
            ],
            finalCountdown: FinalCountdown(lastSeconds: 10, haptic: true),
            colorHex: "#0A84FF",
            repeatCount: 1,
            defaultOutputMode: .vibrationOnly
        )
    }
}
