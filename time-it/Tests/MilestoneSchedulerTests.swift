import XCTest
// The pure model + scheduler sources are compiled directly into this test
// bundle (see project.yml), so the types are in-module — no app import needed.

/// Tests for the pure scheduling logic. Run with:
///   xcodegen generate && xcodebuild test -scheme TimeIt -destination 'platform=iOS Simulator,name=iPhone 15'
final class MilestoneSchedulerTests: XCTestCase {

    // MARK: MilestoneTrigger.fireTime

    func testPercentElapsedResolvesToOffset() {
        XCTAssertEqual(MilestoneTrigger.percentElapsed(0.5).fireTime(forDuration: 60), 30, accuracy: 0.001)
        XCTAssertEqual(MilestoneTrigger.percentElapsed(0.0).fireTime(forDuration: 60), 0, accuracy: 0.001)
        XCTAssertEqual(MilestoneTrigger.percentElapsed(1.0).fireTime(forDuration: 60), 60, accuracy: 0.001)
    }

    func testPercentRemainingResolvesToOffset() {
        // 30% remaining on a 100s timer fires at 70s elapsed.
        XCTAssertEqual(MilestoneTrigger.percentRemaining(0.3).fireTime(forDuration: 100), 70, accuracy: 0.001)
    }

    func testSecondsRemainingClampsIntoWindow() {
        XCTAssertEqual(MilestoneTrigger.secondsRemaining(20).fireTime(forDuration: 60), 40, accuracy: 0.001)
        // A 90s-left marker on a 45s timer clamps to fire at start (offset 0).
        XCTAssertEqual(MilestoneTrigger.secondsRemaining(90).fireTime(forDuration: 45), 0, accuracy: 0.001)
    }

    func testFractionsAreClamped() {
        XCTAssertEqual(MilestoneTrigger.percentElapsed(1.5).fireTime(forDuration: 60), 60, accuracy: 0.001)
        XCTAssertEqual(MilestoneTrigger.percentElapsed(-0.5).fireTime(forDuration: 60), 0, accuracy: 0.001)
    }

    // MARK: dueMilestones

    func testDueMilestonesFireInOrderOnceCrossed() {
        let half = TimerMilestone(trigger: .percentElapsed(0.5), alert: .voice)
        let warn = TimerMilestone(trigger: .secondsRemaining(20), alert: .haptic)
        let preset = TimerPreset(name: "t", duration: 60, milestones: [warn, half])

        // At 25s elapsed: nothing due (half@30, warn@40).
        XCTAssertTrue(MilestoneScheduler.dueMilestones(in: preset, elapsed: 25, alreadyFired: []).isEmpty)

        // At 45s elapsed: both due, returned in fire order (half before warn).
        let due = MilestoneScheduler.dueMilestones(in: preset, elapsed: 45, alreadyFired: [])
        XCTAssertEqual(due.map(\.id), [half.id, warn.id])
    }

    func testDueMilestonesSkipsAlreadyFired() {
        let half = TimerMilestone(trigger: .percentElapsed(0.5), alert: .voice)
        let preset = TimerPreset(name: "t", duration: 60, milestones: [half])
        let due = MilestoneScheduler.dueMilestones(in: preset, elapsed: 45, alreadyFired: [half.id])
        XCTAssertTrue(due.isEmpty)
    }

    // MARK: countdownSecond

    func testCountdownCountsDownWithinWindow() {
        // 9.7s left, window 10, nothing spoken yet -> "10".
        XCTAssertEqual(MilestoneScheduler.countdownSecond(remaining: 9.7, window: 10, lastSpoken: nil), 10)
        // 8.9s left, last spoke 10 -> "9".
        XCTAssertEqual(MilestoneScheduler.countdownSecond(remaining: 8.9, window: 10, lastSpoken: 10), 9)
    }

    func testCountdownDoesNotRepeatSameSecond() {
        // Still 9.x seconds, already spoke 10 -> ceil is 10 again, not below last -> nil.
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 9.4, window: 10, lastSpoken: 10))
    }

    func testCountdownOutsideWindowIsSilent() {
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 30, window: 10, lastSpoken: nil))
        // We never announce "0"; completion handles that.
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 0, window: 10, lastSpoken: 1))
    }

    func testCountdownDisabledWindowIsSilent() {
        XCTAssertNil(MilestoneScheduler.countdownSecond(remaining: 5, window: 0, lastSpoken: nil))
    }

    // MARK: RunningTimerState time math

    // MARK: OutputMode channel resolution

    func testBothModeHonorsMilestoneAlertStyle() {
        let voiceOnly = AlertStyle.voice
        let hapticOnly = AlertStyle.haptic
        XCTAssertEqual(OutputMode.both.channels(forMilestoneAlert: voiceOnly).voice, true)
        XCTAssertEqual(OutputMode.both.channels(forMilestoneAlert: voiceOnly).haptic, false)
        XCTAssertEqual(OutputMode.both.channels(forMilestoneAlert: hapticOnly).voice, false)
        XCTAssertEqual(OutputMode.both.channels(forMilestoneAlert: hapticOnly).haptic, true)
    }

    func testVoiceOnlyForcesSpeechEvenForHapticMilestone() {
        let ch = OutputMode.voiceOnly.channels(forMilestoneAlert: .haptic)
        XCTAssertTrue(ch.voice)
        XCTAssertFalse(ch.haptic)
    }

    func testVibrationOnlyForcesBuzzEvenForVoiceMilestone() {
        let ch = OutputMode.vibrationOnly.channels(forMilestoneAlert: .voice)
        XCTAssertFalse(ch.voice)
        XCTAssertTrue(ch.haptic)
    }

    func testCountdownChannelsPerMode() {
        // Both honors the preset's per-second haptic toggle.
        XCTAssertEqual(OutputMode.both.countdownChannels(hapticEnabled: true).speak, true)
        XCTAssertEqual(OutputMode.both.countdownChannels(hapticEnabled: true).buzz, true)
        XCTAssertEqual(OutputMode.both.countdownChannels(hapticEnabled: false).buzz, false)
        // Voice-only never buzzes; vibrate-only never speaks.
        XCTAssertEqual(OutputMode.voiceOnly.countdownChannels(hapticEnabled: true).buzz, false)
        XCTAssertEqual(OutputMode.vibrationOnly.countdownChannels(hapticEnabled: false).speak, false)
        XCTAssertEqual(OutputMode.vibrationOnly.countdownChannels(hapticEnabled: false).buzz, true)
    }

    func testSpeaksAnnouncements() {
        XCTAssertTrue(OutputMode.both.speaksAnnouncements)
        XCTAssertTrue(OutputMode.voiceOnly.speaksAnnouncements)
        XCTAssertFalse(OutputMode.vibrationOnly.speaksAnnouncements)
    }

    // MARK: RunningTimerState time math

    func testRunningStateElapsedAndRemaining() {
        let preset = TimerPreset(name: "t", duration: 60)
        let start = Date()
        var state = RunningTimerState(preset: preset, now: start)
        let t10 = start.addingTimeInterval(10)
        XCTAssertEqual(state.elapsed(now: t10), 10, accuracy: 0.01)
        XCTAssertEqual(state.remaining(now: t10), 50, accuracy: 0.01)
        XCTAssertEqual(state.progress(now: t10), 10.0/60.0, accuracy: 0.001)

        // Pausing banks elapsed and freezes the clock.
        state.bankedElapsed = state.elapsed(now: t10)
        state.isRunning = false
        let t30 = start.addingTimeInterval(30)
        XCTAssertEqual(state.elapsed(now: t30), 10, accuracy: 0.01)
    }
}
