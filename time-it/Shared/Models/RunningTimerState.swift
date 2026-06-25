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
    /// Per-interval countdown bookkeeping: the boundary we're counting toward and
    /// the last second spoken for it (reset when the target boundary changes).
    var intervalCountdownTarget: TimeInterval?
    var lastIntervalCountdownSecond: Int?

    /// Lead-in ("3,2,1… Let's go") before the main run. The main timer begins at
    /// `startDate`; during the lead-in `startDate` is in the future.
    let leadIn: TimeInterval
    var lastLeadInSecondSpoken: Int?
    var leadInDone: Bool

    init(preset: TimerPreset, now: Date = Date(), leadIn: TimeInterval = 0) {
        self.id = UUID()
        self.preset = preset
        self.leadIn = leadIn
        self.startDate = now.addingTimeInterval(leadIn)   // main starts after lead-in
        self.bankedElapsed = 0
        self.isRunning = true
        self.currentRepeat = 1
        self.firedCueIDs = []
        self.lastCountdownSecondSpoken = nil
        self.intervalCountdownTarget = nil
        self.lastIntervalCountdownSecond = nil
        self.lastLeadInSecondSpoken = nil
        self.leadInDone = leadIn <= 0
    }

    /// Whether we're still in the pre-start lead-in.
    func inLeadIn(now: Date = Date()) -> Bool { leadIn > 0 && now < startDate }
    /// Seconds left in the lead-in (3 → 2 → 1).
    func leadInRemaining(now: Date = Date()) -> TimeInterval { max(0, startDate.timeIntervalSince(now)) }

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

    /// Segment boundaries — the interval-plan boundaries plus the final end,
    /// ascending, >0. These delimit the "intervals" the running view counts down
    /// within. One-off milestones (e.g. a rest's halfway buzz) are deliberately
    /// excluded: they fire their alert but must not chop the countdown in two.
    func segmentBoundaries() -> [TimeInterval] {
        var b = Set(preset.intervals?.boundaries(forDuration: preset.duration) ?? [])
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

    /// For a work/rest plan: which round we're in, whether it's a work phase
    /// (vs the rest), and the total rounds. One round = all work segments + the
    /// rest, so the running view groups them.
    func workRestPhase(now: Date = Date()) -> (round: Int, isWork: Bool, rounds: Int)? {
        guard case .workRest(let rawWorks, let rest)? = preset.intervals?.spec else { return nil }
        let works = rawWorks.filter { $0 > 0 }
        guard !works.isEmpty, rest > 0 else { return nil }
        let roundLen = works.reduce(0, +) + rest
        guard roundLen > 0 else { return nil }

        let e = elapsed(now: now)
        let rounds = max(1, Int((preset.duration / roundLen).rounded(.up)))
        let roundIndex = min(Int(e / roundLen) + 1, rounds)

        // Where are we within the current round? Work segments first, then rest.
        let within = e.truncatingRemainder(dividingBy: roundLen)
        var acc: TimeInterval = 0
        var isWork = false
        for w in works {
            if within < acc + w { isWork = true; break }
            acc += w
        }
        return (roundIndex, isWork, rounds)
    }

    /// Seconds elapsed in the current run. Stays 0 during the lead-in (before
    /// `startDate`).
    func elapsed(now: Date = Date()) -> TimeInterval {
        guard now >= startDate else { return 0 }
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
