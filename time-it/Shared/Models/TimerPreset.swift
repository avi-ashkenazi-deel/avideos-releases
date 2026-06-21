import Foundation

/// The countdown to spoken in the final stretch of a timer, e.g. "10, 9, … 1".
struct FinalCountdown: Codable, Hashable {
    /// Speak each whole second for the last N seconds.
    var lastSeconds: Int = 10
    /// Whether the countdown also buzzes each second on the watch.
    var haptic: Bool = true
}

/// A reusable timer definition the user configures once and starts many times.
///
/// Cues come from two places: the primary `intervals` plan (split the total into
/// announced intervals) and any number of one-off `milestones` (percentage or
/// time-remaining markers). Both are flattened into `cues()` for the engine.
struct TimerPreset: Codable, Hashable, Identifiable {
    var id: UUID = UUID()
    /// Optional friendly name. When empty the UI shows the formatted duration.
    var name: String = ""
    /// Total length of one run, in seconds.
    var duration: TimeInterval
    /// Primary interval plan (the creation flow leads with this). `nil` = none.
    var intervals: IntervalPlan? = nil
    /// One-off custom markers layered on top of the intervals.
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
    /// Whether the watch records this as a Functional Strength Training workout.
    /// Off for non-exercise timers (a talk, cooking…) — the watch then stays
    /// alive with silent audio instead, so nothing is logged to Fitness.
    /// Optional for backward-compatible decoding; treat `nil` as "yes".
    var recordsWorkout: Bool? = true
    /// Which workout the watch records when `recordsWorkout`. nil → functional
    /// strength (the previous fixed behavior).
    var workoutKind: WorkoutKind? = nil

    /// Resolved flag (defaults to true for presets saved before this existed).
    var isWorkout: Bool { recordsWorkout ?? true }
    /// Resolved workout kind.
    var workout: WorkoutKind { workoutKind ?? .functionalStrength }

    /// Name to show in lists / the running view — falls back to the duration.
    var displayName: String {
        name.isEmpty ? "\(formatClock(duration)) timer" : name
    }

    // MARK: Output indicators (for the list row)

    /// Whether this timer will speak — inferred from its cues + final countdown.
    var usesVoice: Bool {
        if finalCountdown != nil { return true }
        return cues().contains { $0.alert.includesVoice && !$0.spokenText.isEmpty }
    }

    /// Whether this timer will vibrate — inferred from its cues + final countdown.
    var usesHaptic: Bool {
        if finalCountdown?.haptic == true { return true }
        return cues().contains { $0.alert.includesHaptic }
    }

    // MARK: Cues

    /// All alert points for one run, flattened from intervals + milestones and
    /// sorted by fire time. De-duplicates milestones that land on an interval
    /// boundary (the interval cue wins).
    func cues() -> [TimerCue] {
        var result: [TimerCue] = []

        if let plan = intervals {
            for (idx, b) in plan.cuePoints(forDuration: duration).enumerated() {
                result.append(TimerCue(
                    id: "interval-\(idx + 1)",
                    fireTime: b.time,
                    alert: plan.alert,
                    haptic: b.haptic,
                    spokenText: b.spokenText,
                    displayLabel: b.label
                ))
            }
        }

        for m in milestones {
            let t = m.trigger.fireTime(forDuration: duration)
            // Skip if an interval boundary already sits on this second.
            if result.contains(where: { abs($0.fireTime - t) < 0.5 }) { continue }
            result.append(TimerCue(
                id: m.id.uuidString,
                fireTime: t,
                alert: m.alert,
                haptic: m.haptic,
                spokenText: m.spokenText(forDuration: duration),
                displayLabel: m.displayLabel(forDuration: duration)
            ))
        }

        return result.sorted { $0.fireTime < $1.fireTime }
    }

    /// The next cue strictly after `elapsed`, for the "up next" UI.
    func nextCue(afterElapsed elapsed: TimeInterval) -> TimerCue? {
        cues().first { $0.fireTime > elapsed + 0.001 }
    }

    // MARK: Sample content

    /// Two ready-made presets covering the two driving use cases.
    static let samples: [TimerPreset] = [gymInterval, conferenceTalk]

    /// Gym: a 60s timer split into 10-second intervals, voice cues + final 10s.
    static var gymInterval: TimerPreset {
        TimerPreset(
            name: "Gym interval",
            duration: 60,
            intervals: IntervalPlan(spec: .spacing(seconds: 10), alert: .voice,
                                    haptic: .notification, announceNumber: true),
            milestones: [],
            finalCountdown: FinalCountdown(lastSeconds: 10, haptic: true),
            colorHex: "#FF9500",
            repeatCount: 1,
            defaultOutputMode: .voiceOnly
        )
    }

    /// Conference talk: 20 minutes split into 4 equal blocks, haptic-only, plus a
    /// one-minute "wrap up" warning.
    static var conferenceTalk: TimerPreset {
        TimerPreset(
            name: "20 min talk",
            duration: 20 * 60,
            intervals: IntervalPlan(spec: .even(count: 4), alert: .haptic,
                                    haptic: .directionUp, announceNumber: false),
            milestones: [
                TimerMilestone(trigger: .secondsRemaining(60), alert: .haptic,
                               haptic: .stop, label: "Wrap up"),
            ],
            finalCountdown: FinalCountdown(lastSeconds: 10, haptic: true),
            colorHex: "#0A84FF",
            repeatCount: 1,
            defaultOutputMode: .vibrationOnly,
            recordsWorkout: false   // a talk isn't exercise
        )
    }
}
