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
    /// Seconds of "3,2,1… Let's go" lead-in before the timer actually starts.
    /// nil/0 = start immediately.
    var startCountdown: Int? = nil

    /// Resolved flag (defaults to true for presets saved before this existed).
    var isWorkout: Bool { recordsWorkout ?? true }
    /// Resolved workout kind.
    var workout: WorkoutKind { workoutKind ?? .functionalStrength }

    /// Name to show in lists / the running view — falls back to the duration.
    var displayName: String {
        name.isEmpty ? "\(formatClock(duration)) timer" : name
    }

    /// Spoken at the very start: the first interval's custom name if one is set,
    /// otherwise "Starting <name>".
    var startAnnouncement: String {
        intervals?.stepName(forSegment: 0) ?? "Starting \(displayName)"
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

    // MARK: Feedback preview

    /// One feedback moment in a run: the elapsed second it happens and whether
    /// it's spoken, felt, or both.
    struct FeedbackEvent: Identifiable, Hashable {
        var id: Int { Int(time.rounded()) &* 31 &+ title.hashValue }
        /// Elapsed seconds from the start of the run.
        let time: TimeInterval
        let title: String
        let voice: Bool
        let haptic: Bool
    }

    /// A flat, second-by-second preview of everything the user will hear or feel
    /// in one run and when — the lead-in, each interval/milestone cue, the final
    /// spoken countdown (expanded per second), and the finish. Used by the editor
    /// preview for non-workout timers so a speaker can see their whole cue plan.
    func feedbackTimeline() -> [FeedbackEvent] {
        guard duration > 0 else { return [] }
        var events: [FeedbackEvent] = []

        // Lead-in: "3, 2, 1… Let's go" just before the clock starts.
        if let lead = startCountdown, lead > 0 {
            events.append(.init(time: 0, title: "“3, 2, 1… Let's go”", voice: true, haptic: true))
        }

        // Interval boundaries + one-off milestones.
        let cueList = cues()
        for cue in cueList {
            let title = cue.spokenText.isEmpty ? cue.displayLabel : "“\(cue.spokenText)”"
            events.append(.init(time: cue.fireTime, title: title,
                                voice: cue.alert.includesVoice && !cue.spokenText.isEmpty,
                                haptic: cue.alert.includesHaptic))
        }

        // Final spoken countdown — shown as one summary row ("10-second
        // countdown") rather than a row per second.
        if let fc = finalCountdown, fc.lastSeconds > 0 {
            let t = max(0, duration - Double(fc.lastSeconds))
            events.append(.init(time: t, title: "\(fc.lastSeconds)-second countdown",
                                voice: true, haptic: fc.haptic))
        }

        // The finish itself.
        events.append(.init(time: duration, title: "Time's up", voice: false, haptic: true))

        return events.sorted { $0.time < $1.time }
    }

    // MARK: Sample content

    /// The starter library seeded on first launch — a spread that shows off what
    /// the app does (work/rest sets, every-minute cues, vibration-only talks,
    /// a silent focus timer) and covers the most common real uses.
    static let samples: [TimerPreset] = [tabata, hiit4020, emom10, conferenceTalk, focus25]

    /// Tabata: 8 rounds of 20s work / 10s rest (4 min), spoken + buzz, logged as HIIT.
    static var tabata: TimerPreset {
        TimerPreset(
            name: "Tabata",
            duration: 4 * 60,
            intervals: IntervalPlan(spec: .workRest(works: [20], rest: 10),
                                    alert: .voiceAndHaptic, haptic: .notification,
                                    announceNumber: true, countdown: 5),
            finalCountdown: FinalCountdown(lastSeconds: 5, haptic: true),
            colorHex: "#FF375F",
            workoutKind: .hiit,
            startCountdown: 3
        )
    }

    /// HIIT 40/20: 8 rounds of 40s work / 20s rest (8 min), spoken + buzz.
    static var hiit4020: TimerPreset {
        TimerPreset(
            name: "HIIT 40/20",
            duration: 8 * 60,
            intervals: IntervalPlan(spec: .workRest(works: [40], rest: 20),
                                    alert: .voiceAndHaptic, haptic: .notification,
                                    announceNumber: true, countdown: 5),
            finalCountdown: FinalCountdown(lastSeconds: 5, haptic: true),
            colorHex: "#FF9500",
            workoutKind: .hiit,
            startCountdown: 3
        )
    }

    /// EMOM: a cue every minute on the minute for 10 minutes, spoken + buzz.
    static var emom10: TimerPreset {
        TimerPreset(
            name: "EMOM 10",
            duration: 10 * 60,
            intervals: IntervalPlan(spec: .spacing(seconds: 60), alert: .voiceAndHaptic,
                                    haptic: .notification, announceNumber: true, countdown: 5),
            colorHex: "#30D158",
            workoutKind: .functionalStrength,
            startCountdown: 3
        )
    }

    /// Conference talk: 20 minutes split into 4 equal blocks, vibration-only, plus
    /// a one-minute "wrap up" buzz. Not logged as exercise.
    static var conferenceTalk: TimerPreset {
        TimerPreset(
            name: "20-min talk",
            duration: 20 * 60,
            intervals: IntervalPlan(spec: .even(count: 4), alert: .haptic,
                                    haptic: .directionUp, announceNumber: false),
            milestones: [
                TimerMilestone(trigger: .secondsRemaining(60), alert: .haptic,
                               haptic: .stop, label: "Wrap up"),
            ],
            finalCountdown: FinalCountdown(lastSeconds: 10, haptic: true),
            colorHex: "#0A84FF",
            recordsWorkout: false   // a talk isn't exercise
        )
    }

    /// Focus 25 (Pomodoro): a silent 25-minute block with a vibration at 5 minutes
    /// left and at the end. Not logged as exercise.
    static var focus25: TimerPreset {
        TimerPreset(
            name: "Focus 25",
            duration: 25 * 60,
            intervals: nil,
            milestones: [
                TimerMilestone(trigger: .secondsRemaining(5 * 60), alert: .haptic,
                               haptic: .directionDown, label: "5 minutes left"),
            ],
            finalCountdown: FinalCountdown(lastSeconds: 5, haptic: true),
            colorHex: "#BF5AF2",
            recordsWorkout: false
        )
    }
}
