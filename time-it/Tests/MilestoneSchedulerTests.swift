import XCTest
// The pure model + scheduler sources are compiled directly into this test
// bundle (see project.yml), so the types are in-module — no app import needed.

/// Tests for the pure scheduling logic. Run with:
///   xcodegen generate && xcodebuild test -scheme TimeIt -destination 'platform=iOS Simulator,name=iPhone 15'
final class MilestoneSchedulerTests: XCTestCase {

    // MARK: MilestoneTrigger.fireTime

    func testPercentElapsedResolvesToOffset() {
        XCTAssertEqual(MilestoneTrigger.percentElapsed(0.5).fireTime(forDuration: 60), 30, accuracy: 0.001)
        XCTAssertEqual(MilestoneTrigger.percentElapsed(1.0).fireTime(forDuration: 60), 60, accuracy: 0.001)
    }

    func testSecondsRemainingClampsIntoWindow() {
        XCTAssertEqual(MilestoneTrigger.secondsRemaining(20).fireTime(forDuration: 60), 40, accuracy: 0.001)
        XCTAssertEqual(MilestoneTrigger.secondsRemaining(90).fireTime(forDuration: 45), 0, accuracy: 0.001)
    }

    // MARK: IntervalPlan.boundaries

    func testEvenSplitBoundaries() {
        let plan = IntervalPlan(spec: .even(count: 4))
        XCTAssertEqual(plan.boundaries(forDuration: 60), [15, 30, 45])
        XCTAssertEqual(plan.intervalCount(forDuration: 60), 4)
    }

    func testSpacingBoundariesDropTheEnd() {
        let plan = IntervalPlan(spec: .spacing(seconds: 10))
        // 60s every 10s -> 10,20,30,40,50 (60 is the end, excluded).
        XCTAssertEqual(plan.boundaries(forDuration: 60), [10, 20, 30, 40, 50])
    }

    func testCustomBoundariesAreCumulative() {
        let plan = IntervalPlan(spec: .custom(lengths: [20, 30, 10]))
        // 20, then 50; the trailing 10 lands on the 60s end and is dropped.
        XCTAssertEqual(plan.boundaries(forDuration: 60), [20, 50])
    }

    func testWorkRestAlternatesAndLabels() {
        let plan = IntervalPlan(spec: .workRest(works: [30], rest: 10), announceNumber: true)
        // 30 (rest), 40 (work), 70 (rest), 80 (work); 110 overruns 100 -> stop.
        XCTAssertEqual(plan.boundaries(forDuration: 100), [30, 40, 70, 80])
        let points = plan.cuePoints(forDuration: 100)
        XCTAssertEqual(points.map(\.label), ["Rest", "Round 2", "Rest", "Round 3"])
    }

    func testWorkRestMultipleWorksBeforeRest() {
        // Two 20s works, then a 10s rest, repeating over 100s.
        let plan = IntervalPlan(spec: .workRest(works: [20, 20], rest: 10), announceNumber: true)
        XCTAssertEqual(plan.boundaries(forDuration: 100), [20, 40, 50, 70, 90])
        XCTAssertEqual(plan.cuePoints(forDuration: 100).map(\.label),
                       ["Exercise 2", "Rest", "Round 2", "Exercise 2", "Rest"])
    }

    // MARK: TimerPreset.cues (intervals + milestones unified)

    func testCuesMergeIntervalsAndMilestones() {
        let warn = TimerMilestone(trigger: .secondsRemaining(5), alert: .haptic) // fires at 55
        let preset = TimerPreset(
            name: "t", duration: 60,
            intervals: IntervalPlan(spec: .even(count: 2)), // boundary at 30
            milestones: [warn]
        )
        let cues = preset.cues()
        XCTAssertEqual(cues.map { Int($0.fireTime) }, [30, 55])
        XCTAssertEqual(cues.first?.id, "interval-1")
    }

    func testMilestoneOnIntervalBoundaryIsDeduped() {
        let onBoundary = TimerMilestone(trigger: .percentElapsed(0.5), alert: .voice) // 30s
        let preset = TimerPreset(
            name: "t", duration: 60,
            intervals: IntervalPlan(spec: .even(count: 2)), // also 30s
            milestones: [onBoundary]
        )
        // The interval cue wins; only one cue at 30s.
        XCTAssertEqual(preset.cues().count, 1)
    }

    // MARK: dueCues

    func testDueCuesFireInOrderOnceCrossed() {
        let preset = TimerPreset(name: "t", duration: 60,
                                 intervals: IntervalPlan(spec: .spacing(seconds: 20)))
        let cues = preset.cues() // 20, 40
        XCTAssertTrue(MilestoneScheduler.dueCues(cues, elapsed: 10, alreadyFired: []).isEmpty)
        let due = MilestoneScheduler.dueCues(cues, elapsed: 45, alreadyFired: [])
        XCTAssertEqual(due.map(\.id), ["interval-1", "interval-2"])
    }

    func testDueCuesSkipsAlreadyFired() {
        let preset = TimerPreset(name: "t", duration: 60,
                                 intervals: IntervalPlan(spec: .spacing(seconds: 20)))
        let cues = preset.cues()
        let due = MilestoneScheduler.dueCues(cues, elapsed: 45, alreadyFired: ["interval-1"])
        XCTAssertEqual(due.map(\.id), ["interval-2"])
    }

    // MARK: countdownSecond

    func testCountdownCountsDownWithinWindow() {
        XCTAssertEqual(MilestoneScheduler.countdownSecond(remaining: 9.7, window: 10, lastSpoken: nil), 10)
        XCTAssertEqual(MilestoneScheduler.countdownSecond(remaining: 8.9, window: 10, lastSpoken: 10), 9)
    }

    func testCountdownDoesNotRepeatSameSecond() {
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 9.4, window: 10, lastSpoken: 10))
    }

    func testCountdownOutsideWindowIsSilent() {
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 30, window: 10, lastSpoken: nil))
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 0, window: 10, lastSpoken: 1))
    }

    // MARK: RunningTimerState time math

    func testRunningStateElapsedAndRemaining() {
        let preset = TimerPreset(name: "t", duration: 60)
        let start = Date()
        var state = RunningTimerState(preset: preset, now: start)
        let t10 = start.addingTimeInterval(10)
        XCTAssertEqual(state.elapsed(now: t10), 10, accuracy: 0.01)
        XCTAssertEqual(state.remaining(now: t10), 50, accuracy: 0.01)

        state.bankedElapsed = state.elapsed(now: t10)
        state.isRunning = false
        let t30 = start.addingTimeInterval(30)
        XCTAssertEqual(state.elapsed(now: t30), 10, accuracy: 0.01)
    }
}
