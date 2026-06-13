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

    // MARK: Intervals (the segment currently in progress)

    /// Segment boundaries — cue fire times plus the final end — ascending, >0.
    /// These delimit the "intervals" the running view counts down within.
    func segmentBoundaries() -> [TimeInterval] {
        var b = Set(preset.cues().map(\.fireTime))
        b.insert(preset.duration)
        return b.filter { $0 > 0.0001 }.sorted()
    }

    /// Start / end (elapsed offsets) of the interval currently in progress.
    func currentSegment(now: Date = Date()) -> (start: TimeInterval, end: TimeInterval) {
        let e = elapsed(now: now)
        let bounds = segmentBoundaries()
        let end = bounds.first { $0 > e + 0.0001 } ?? preset.duration
        let start = bounds.last { $0 <= e + 0.0001 } ?? 0
        return (start, end)
    }

    /// Seconds left in the interval currently in progress.
    func intervalRemaining(now: Date = Date()) -> TimeInterval {
        max(0, currentSegment(now: now).end - elapsed(now: now))
    }

    /// 0...1 of the current interval remaining (drives the draining fill).
    func intervalFraction(now: Date = Date()) -> Double {
        let seg = currentSegment(now: now)
        let len = seg.end - seg.start
        guard len > 0 else { return 0 }
        return max(0, min(1, intervalRemaining(now: now) / len))
    }

    /// Label of the interval currently in progress (e.g. "Interval 2", "Rest"),
    /// taken from the cue that *starts* it; nil for the opening segment.
    func currentIntervalLabel(now: Date = Date()) -> String? {
        let start = currentSegment(now: now).start
        guard start > 0.0001 else { return nil }
        return preset.cues().first { abs($0.fireTime - start) < 0.5 }?.displayLabel
    }

    /// (current, total) segment position, 1-based, for an "interval i/N" readout.
    func intervalPosition(now: Date = Date()) -> (index: Int, total: Int) {
        let bounds = segmentBoundaries()
        let total = max(1, bounds.count)
        let passed = bounds.filter { $0 <= elapsed(now: now) + 0.0001 }.count
        return (min(passed + 1, total), total)
    }

    /// For a work/rest plan: which round we're in, whether it's the work phase,
    /// and the total rounds. A work + rest pair is ONE round (one interval), so
    /// the running view groups them rather than counting two.
    func workRestPhase(now: Date = Date()) -> (round: Int, isWork: Bool, rounds: Int)? {
        guard case .workRest(let work, let rest)? = preset.intervals?.spec else { return nil }
        let cueTimes = preset.cues().map(\.fireTime).sorted()
        let passed = cueTimes.filter { $0 <= elapsed(now: now) + 0.0001 }.count
        let rounds = max(1, Int(preset.duration / max(1, work + rest)))
        return (passed / 2 + 1, passed % 2 == 0, rounds)
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
