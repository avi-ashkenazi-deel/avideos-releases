import Foundation

/// Pure functions that decide *what* should fire at a given moment. Kept free of
/// timers, state mutation, and platform APIs so they can be unit-tested on any
/// platform (see `Tests/`). `TimerEngine` calls these on every tick.
enum MilestoneScheduler {

    /// Milestones whose fire-time has been reached but that haven't fired yet,
    /// returned in fire order. (Several can come due in one tick.)
    static func dueMilestones(
        in preset: TimerPreset,
        elapsed: TimeInterval,
        alreadyFired: Set<UUID>
    ) -> [TimerMilestone] {
        preset.sortedMilestones().filter { m in
            guard !alreadyFired.contains(m.id) else { return false }
            return m.trigger.fireTime(forDuration: preset.duration) <= elapsed
        }
    }

    /// The whole-second value the final countdown should speak right now, or nil
    /// if nothing new should be spoken.
    ///
    /// - `remaining`: seconds left in the run.
    /// - `window`: speak the last N seconds (e.g. 10 → "10…1").
    /// - `lastSpoken`: the previous second we spoke, so we don't repeat within a
    ///   tick interval or speak the same number twice.
    ///
    /// Returns a value in `1...window`. We deliberately do not announce "0" — the
    /// completion event handles "time's up".
    static func countdownSecond(
        remaining: TimeInterval,
        window: Int,
        lastSpoken: Int?
    ) -> Int? {
        guard window > 0, remaining > 0 else { return nil }
        // ceil so that with 9.7s left we're already on "10".
        let second = Int(remaining.rounded(.up))
        guard second >= 1, second <= window else { return nil }
        if let lastSpoken, second >= lastSpoken { return nil } // only count down
        return second
    }
}
