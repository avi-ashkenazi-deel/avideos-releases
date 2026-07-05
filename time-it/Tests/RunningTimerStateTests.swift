import XCTest
// Pure model sources are compiled into this bundle — types are in-module.

/// Timing/segment logic for a running timer: interval boundaries, warm-up /
/// cool-down offsets, work-rest phase, and crash-restore round-trips.
final class RunningTimerStateTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func plain(_ duration: TimeInterval,
                       intervals: IntervalPlan? = nil,
                       warmup: TimeInterval? = nil,
                       cooldown: TimeInterval? = nil) -> TimerPreset {
        TimerPreset(duration: duration, intervals: intervals,
                    finalCountdown: nil, warmup: warmup, cooldown: cooldown)
    }

    // MARK: IntervalPlan.boundaries

    func testEvenBoundaries() {
        let p = IntervalPlan(spec: .even(count: 4))
        XCTAssertEqual(p.boundaries(forDuration: 60), [15, 30, 45])
    }

    func testSpacingBoundaries() {
        let p = IntervalPlan(spec: .spacing(seconds: 10))
        XCTAssertEqual(p.boundaries(forDuration: 60), [10, 20, 30, 40, 50])
    }

    func testCustomBoundaries() {
        let p = IntervalPlan(spec: .custom(lengths: [20, 20, 20]))
        XCTAssertEqual(p.boundaries(forDuration: 60), [20, 40])
    }

    // MARK: runDuration + cue offsets for warm-up / cool-down

    func testRunDurationBracketsWork() {
        let p = plain(60, warmup: 10, cooldown: 15)
        XCTAssertEqual(p.runDuration, 85, accuracy: 0.001)
    }

    func testCuesShiftPastWarmup() {
        let p = plain(60, intervals: IntervalPlan(spec: .even(count: 4)),
                      warmup: 10, cooldown: 10)
        let times = p.cues().map(\.fireTime)
        // work-start(10), intervals 15/30/45 +10 = 25/40/55, cooldown-start(70)
        XCTAssertEqual(times, [10, 25, 40, 55, 70])
    }

    // MARK: segment boundaries / current segment

    func testSegmentBoundariesWithWarmupCooldown() {
        let p = plain(60, intervals: IntervalPlan(spec: .even(count: 4)),
                      warmup: 10, cooldown: 10)
        let s = RunningTimerState(preset: p, now: t0)
        XCTAssertEqual(s.segmentBoundaries(), [10, 25, 40, 55, 70, 80])
    }

    func testCurrentSegmentDuringWarmupThenWork() {
        let p = plain(60, intervals: IntervalPlan(spec: .even(count: 4)), warmup: 10)
        let s = RunningTimerState(preset: p, now: t0)
        // 5s in → warm-up segment 0..10
        let warm = s.currentSegment(now: t0.addingTimeInterval(5))
        XCTAssertEqual(warm.start, 0, accuracy: 0.01)
        XCTAssertEqual(warm.end, 10, accuracy: 0.01)
        // 12s in → first work interval 10..25
        let work = s.currentSegment(now: t0.addingTimeInterval(12))
        XCTAssertEqual(work.start, 10, accuracy: 0.01)
        XCTAssertEqual(work.end, 25, accuracy: 0.01)
    }

    func testRemainingUsesRunDuration() {
        let p = plain(60, warmup: 10, cooldown: 10)
        let s = RunningTimerState(preset: p, now: t0)
        XCTAssertEqual(s.remaining(now: t0), 80, accuracy: 0.01)
        XCTAssertEqual(s.remaining(now: t0.addingTimeInterval(30)), 50, accuracy: 0.01)
    }

    // MARK: work/rest phase

    func testWorkRestPhaseOnlyDuringWork() {
        let p = plain(60, intervals: IntervalPlan(spec: .workRest(works: [20], rest: 10)),
                      warmup: 10)
        let s = RunningTimerState(preset: p, now: t0)
        // During warm-up → no phase.
        XCTAssertNil(s.workRestPhase(now: t0.addingTimeInterval(5)))
        // 5s into work (elapsed 15) → round 1, working.
        let phase = s.workRestPhase(now: t0.addingTimeInterval(15))
        XCTAssertEqual(phase?.round, 1)
        XCTAssertEqual(phase?.isWork, true)
    }

    // MARK: crash-restore round trip

    func testSnapshotRoundTrip() {
        let p = plain(120, intervals: IntervalPlan(spec: .even(count: 4)))
        var s = RunningTimerState(preset: p, now: t0)
        s.bankedElapsed = 30
        let restored = RunningTimerState(restoring: s.snapshot)
        XCTAssertEqual(restored.id, s.id)
        XCTAssertEqual(restored.bankedElapsed, 30, accuracy: 0.001)
        XCTAssertEqual(restored.preset.duration, 120, accuracy: 0.001)
        XCTAssertEqual(restored.segmentBoundaries(), s.segmentBoundaries())
    }

    func testMarkElapsedCuesFiredSuppressesBurst() {
        let p = plain(60, intervals: IntervalPlan(spec: .even(count: 4)))
        var s = RunningTimerState(preset: p, now: t0)
        s.bankedElapsed = 50   // most cues now in the past
        s.markElapsedCuesFired(now: t0)
        let due = MilestoneScheduler.dueCues(s.cues, elapsed: 50, alreadyFired: s.firedCueIDs)
        XCTAssertTrue(due.isEmpty)
    }
}
