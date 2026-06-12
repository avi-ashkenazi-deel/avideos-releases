import Foundation

/// One live timer the engine is currently driving. Time is derived from
/// wall-clock dates rather than accumulated ticks, so it stays accurate even if
/// a tick is delayed or the app is briefly suspended.
struct RunningTimerState: Identifiable {
    let id: UUID
    /// Mutable so a running timer can be edited live (time + cues).
    var preset: TimerPreset

    /// When the *current* run started counting (advances across repeats).
    var startDate: Date
    /// Elapsed time banked before the latest pause; `nil`-equivalent is 0.
    var bankedElapsed: TimeInterval
    var isRunning: Bool
    /// Which repeat we're on (1-based).
    var currentRepeat: Int

    /// Cue ids already fired in the *current* run (reset each repeat).
    var firedCueIDs: Set<String>
    /// The last whole second spoken by the final countdown, to avoid repeats.
    var lastCountdownSecondSpoken: Int?

    init(preset: TimerPreset, now: Date = Date()) {
        self.id = UUID()
        self.preset = preset
        self.startDate = now
        self.bankedElapsed = 0
        self.isRunning = true
        self.currentRepeat = 1
        self.firedCueIDs = []
        self.lastCountdownSecondSpoken = nil
    }

    /// Absolute wall-clock time at which the current run completes (assuming it
    /// keeps running). Used to drive Live Activity / notification scheduling.
    func endDate(now: Date = Date()) -> Date {
        now.addingTimeInterval(remaining(now: now))
    }

    /// The next upcoming cue label after the current elapsed, if any.
    func nextCueLabel(now: Date = Date()) -> String? {
        preset.nextCue(afterElapsed: elapsed(now: now))?.displayLabel
    }

    /// Seconds elapsed in the current run.
    func elapsed(now: Date = Date()) -> TimeInterval {
        let live = isRunning ? now.timeIntervalSince(startDate) : 0
        return min(bankedElapsed + live, preset.duration)
    }

    /// Seconds left in the current run.
    func remaining(now: Date = Date()) -> TimeInterval {
        max(0, preset.duration - elapsed(now: now))
    }

    /// 0...1 progress through the current run.
    func progress(now: Date = Date()) -> Double {
        guard preset.duration > 0 else { return 1 }
        return min(1, elapsed(now: now) / preset.duration)
    }

    /// True when the current run has reached its full duration.
    func isComplete(now: Date = Date()) -> Bool {
        elapsed(now: now) >= preset.duration
    }

    /// Whether there's another repeat to run after the current one.
    var hasNextRepeat: Bool { currentRepeat < preset.repeatCount }
}
