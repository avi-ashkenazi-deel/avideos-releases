import XCTest
import AVFoundation
@testable import AVideosStudio

/// Pins the live-music timing arithmetic: playhead resolution while a region
/// loops, when a queued switch is allowed to commit, and the loop-mode
/// precedence rule.
///
/// This is the whole reason the maths lives in `MusicTiming.swift` rather than
/// inside `MusicPlayer` — none of it can be exercised on this machine through
/// AVAudioEngine, but all of it is arithmetic that is wrong silently.
final class MusicTimingTests: XCTestCase {

    private let rate = CanonicalAudio.sampleRate   // 48_000

    // MARK: Unit conversion

    func testSecondsToFramesRoundTrips() {
        for seconds in [0.0, 0.5, 1.0, 12.5, 137.25] {
            let frames = MusicClock.frames(fromSeconds: seconds)
            XCTAssertEqual(MusicClock.seconds(fromFrames: frames), seconds, accuracy: 1e-9,
                           "\(seconds)s should survive a round trip")
        }
    }

    func testSecondsToFramesRoundsRatherThanTruncates() {
        // 12.5s at 48kHz is exactly 600000, but a value that lands mid-frame
        // must round to the nearest frame, not toward zero — truncation at one
        // end of a loop and rounding at the other gives a different error at
        // each end, which is an audible tick every pass.
        let almost = (600_000.6) / rate
        XCTAssertEqual(MusicClock.frames(fromSeconds: almost), 600_001)
    }

    // MARK: Region construction

    func testRegionFromSeconds() {
        let region = try! LoopRegion.make(startSeconds: 10,
                                          endSeconds: 20,
                                          trackDurationSeconds: 180).get()
        XCTAssertEqual(region.startFrame, AVAudioFramePosition(10 * rate))
        XCTAssertEqual(region.lengthFrames, AVAudioFramePosition(10 * rate))
        XCTAssertEqual(region.endFrame, AVAudioFramePosition(20 * rate))
    }

    func testRegionClampsToTrack() {
        // An end past the file is clamped rather than rejected: a section
        // authored against a longer version of the file should still work.
        let region = try! LoopRegion.make(startSeconds: 100,
                                          endSeconds: 999,
                                          trackDurationSeconds: 120).get()
        XCTAssertEqual(region.endFrame, AVAudioFramePosition(120 * rate))
    }

    func testRegionRejectsTooShort() {
        // Below the floor a "loop" is a buzz, and a zero-frame schedule would
        // complete immediately and spin the completion handler.
        XCTAssertEqual(LoopRegion.make(startSeconds: 10, endSeconds: 10,
                                       trackDurationSeconds: 180),
                       .failure(.tooShort))
        XCTAssertEqual(LoopRegion.make(startSeconds: 10, endSeconds: 10.01,
                                       trackDurationSeconds: 180),
                       .failure(.tooShort))
    }

    func testRegionRejectsBackwards() {
        XCTAssertEqual(LoopRegion.make(startSeconds: 30, endSeconds: 10,
                                       trackDurationSeconds: 180),
                       .failure(.tooShort))
    }

    func testRegionRejectsTooLong() {
        // Refused rather than silently given worse switch behaviour.
        XCTAssertEqual(LoopRegion.make(startSeconds: 0, endSeconds: 200,
                                       trackDurationSeconds: 600),
                       .failure(.tooLong))
    }

    func testRegionRejectsEmptyTrack() {
        XCTAssertEqual(LoopRegion.make(startSeconds: 0, endSeconds: 10,
                                       trackDurationSeconds: 0),
                       .failure(.outsideTrack))
    }

    // MARK: Position — linear

    func testLinearPositionAdvancesFromAnchor() {
        let anchor = PlaybackAnchor(nodeSampleTime: 0,
                                    trackFrame: MusicClock.frames(fromSeconds: 30),
                                    region: nil)
        let at = MusicPositionMath.resolve(anchor: anchor,
                                           nodeSampleTime: AVAudioFramePosition(5 * rate))
        XCTAssertEqual(at.seconds, 35, accuracy: 1e-9)
        XCTAssertEqual(at.iteration, 0)
        XCTAssertNil(at.framesToBoundary, "linear playback has no loop boundary")
    }

    func testLinearPositionUsesTheNodeAnchorNotZero() {
        // A hard cut anchors mid-stream, so elapsed is measured from the
        // anchor's node time rather than from the node clock's origin.
        let anchor = PlaybackAnchor(nodeSampleTime: AVAudioFramePosition(100 * rate),
                                    trackFrame: 0,
                                    region: nil)
        let at = MusicPositionMath.resolve(anchor: anchor,
                                           nodeSampleTime: AVAudioFramePosition(103 * rate))
        XCTAssertEqual(at.seconds, 3, accuracy: 1e-9)
    }

    // MARK: Position — looping

    private var tenToTwenty: LoopRegion {
        try! LoopRegion.make(startSeconds: 10, endSeconds: 20,
                             trackDurationSeconds: 180).get()
    }

    private func loopingAnchor() -> PlaybackAnchor {
        PlaybackAnchor(nodeSampleTime: 0,
                       trackFrame: MusicClock.frames(fromSeconds: 10),
                       region: tenToTwenty)
    }

    func testLoopPositionWithinFirstPass() {
        let at = MusicPositionMath.resolve(anchor: loopingAnchor(),
                                           nodeSampleTime: AVAudioFramePosition(3 * rate))
        XCTAssertEqual(at.seconds, 13, accuracy: 1e-9)
        XCTAssertEqual(at.iteration, 0)
        XCTAssertEqual(at.framesToBoundary, AVAudioFramePosition(7 * rate))
    }

    func testLoopPositionWrapsOnSecondPass() {
        // 13s elapsed through a 10s region = 3s into pass 1.
        let at = MusicPositionMath.resolve(anchor: loopingAnchor(),
                                           nodeSampleTime: AVAudioFramePosition(13 * rate))
        XCTAssertEqual(at.seconds, 13, accuracy: 1e-9)
        XCTAssertEqual(at.iteration, 1)
    }

    func testLoopPositionStillCorrectAfterThousandsOfPasses() {
        // The whole point of the modulus: this is what the old
        // `scheduledFromFrame + sampleTime` formula got wrong, running off the
        // end of the region instead of wrapping.
        let elapsed = AVAudioFramePosition(7_000 * 10 * rate) + AVAudioFramePosition(4 * rate)
        let at = MusicPositionMath.resolve(anchor: loopingAnchor(), nodeSampleTime: elapsed)
        XCTAssertEqual(at.seconds, 14, accuracy: 1e-6)
        XCTAssertEqual(at.iteration, 7_000)
    }

    func testLoopPositionExactlyOnTheBoundaryReadsAsTheRegionStart() {
        let at = MusicPositionMath.resolve(anchor: loopingAnchor(),
                                           nodeSampleTime: AVAudioFramePosition(10 * rate))
        XCTAssertEqual(at.seconds, 10, accuracy: 1e-9)
        XCTAssertEqual(at.iteration, 1)
        XCTAssertEqual(at.framesToBoundary, tenToTwenty.lengthFrames)
    }

    func testClockBeforeTheAnchorClampsRatherThanGoingNegative() {
        // Reading the node clock across a reschedule can hand back a value
        // earlier than the anchor; a negative position would show as a jump.
        let anchor = PlaybackAnchor(nodeSampleTime: AVAudioFramePosition(50 * rate),
                                    trackFrame: MusicClock.frames(fromSeconds: 10),
                                    region: tenToTwenty)
        let at = MusicPositionMath.resolve(anchor: anchor,
                                           nodeSampleTime: AVAudioFramePosition(40 * rate))
        XCTAssertEqual(at.seconds, 10, accuracy: 1e-9)
        XCTAssertEqual(at.iteration, 0)
    }

    func testSingleFrameRegionDoesNotDivideByZero() {
        let region = LoopRegion(startFrame: 1_000, lengthFrames: 1)
        let anchor = PlaybackAnchor(nodeSampleTime: 0, trackFrame: 1_000, region: region)
        let at = MusicPositionMath.resolve(anchor: anchor, nodeSampleTime: 5)
        XCTAssertEqual(at.trackFrame, 1_000)
        XCTAssertEqual(at.iteration, 5)
    }

    func testZeroLengthRegionFallsBackToLinear() {
        let region = LoopRegion(startFrame: 0, lengthFrames: 0)
        let anchor = PlaybackAnchor(nodeSampleTime: 0, trackFrame: 0, region: region)
        let at = MusicPositionMath.resolve(anchor: anchor,
                                           nodeSampleTime: AVAudioFramePosition(2 * rate))
        XCTAssertEqual(at.seconds, 2, accuracy: 1e-9)
        XCTAssertNil(at.framesToBoundary)
    }

    // MARK: Boundary arithmetic

    func testBoundaryIsExactArithmeticNotAClockRead() {
        let anchor = loopingAnchor()
        let length = tenToTwenty.lengthFrames
        XCTAssertEqual(MusicPositionMath.boundaryNodeSampleTime(anchor: anchor, iteration: 0),
                       length)
        XCTAssertEqual(MusicPositionMath.boundaryNodeSampleTime(anchor: anchor, iteration: 3),
                       4 * length)
    }

    func testBoundaryIsNilWhenNotLooping() {
        let anchor = PlaybackAnchor(nodeSampleTime: 0, trackFrame: 0, region: nil)
        XCTAssertNil(MusicPositionMath.boundaryNodeSampleTime(anchor: anchor, iteration: 0))
    }

    // MARK: Commit window

    private let window = MusicClock.frames(fromSeconds: 0.5)

    func testCommitWaitsWhileTheBoundaryIsFarAway() {
        XCTAssertEqual(SwitchCommit.decide(framesToBoundary: AVAudioFramePosition(6 * rate),
                                           regionLength: AVAudioFramePosition(10 * rate),
                                           nodeSampleTime: 0,
                                           window: window),
                       .wait)
    }

    func testCommitFiresInsideTheWindowWithTheRightBoundary() {
        let toBoundary = MusicClock.frames(fromSeconds: 0.4)
        let now = AVAudioFramePosition(123_456)
        XCTAssertEqual(SwitchCommit.decide(framesToBoundary: toBoundary,
                                          regionLength: AVAudioFramePosition(10 * rate),
                                          nodeSampleTime: now,
                                          window: window),
                       .commitNow(boundaryNodeSampleTime: now + toBoundary))
    }

    func testCommitFiresExactlyAtTheWindowEdge() {
        XCTAssertEqual(SwitchCommit.decide(framesToBoundary: window,
                                          regionLength: AVAudioFramePosition(10 * rate),
                                          nodeSampleTime: 0,
                                          window: window),
                       .commitNow(boundaryNodeSampleTime: window))
    }

    func testShortRegionCommitsImmediately() {
        // A region under two windows has no room to wait, so it commits now and
        // lands a pass or two later — stated rather than hidden.
        let short = MusicClock.frames(fromSeconds: 0.8)
        let toBoundary = MusicClock.frames(fromSeconds: 0.7)
        XCTAssertEqual(SwitchCommit.decide(framesToBoundary: toBoundary,
                                          regionLength: short,
                                          nodeSampleTime: 0,
                                          window: window),
                       .commitNow(boundaryNodeSampleTime: toBoundary))
    }

    func testZeroLengthRegionNeverCommits() {
        XCTAssertEqual(SwitchCommit.decide(framesToBoundary: 100,
                                           regionLength: 0,
                                           nodeSampleTime: 0,
                                           window: window),
                       .wait)
    }

    // MARK: Boundary reconciliation

    func testReconcileLeavesAPredictionInsideTolerance() {
        let length = AVAudioFramePosition(10 * rate)
        XCTAssertEqual(SwitchCommit.reconcile(predicted: 480_000,
                                              observed: 480_240,
                                              regionLength: length,
                                              tolerance: 4_800),
                       480_000)
    }

    func testReconcileCorrectsAWholePassLate() {
        let length = AVAudioFramePosition(10 * rate)
        XCTAssertEqual(SwitchCommit.reconcile(predicted: 480_000,
                                              observed: 480_000 + length + 100,
                                              regionLength: length,
                                              tolerance: 4_800),
                       480_000 + length)
    }

    func testReconcileCorrectsSeveralPassesEarly() {
        let length = AVAudioFramePosition(10 * rate)
        XCTAssertEqual(SwitchCommit.reconcile(predicted: 480_000 + 3 * length,
                                              observed: 480_000,
                                              regionLength: length,
                                              tolerance: 4_800),
                       480_000)
    }

    // MARK: Loop-mode precedence

    func testSectionLoopSuspendsPlaylistAdvance() {
        // While a section loops the buffer never ends, so track completion
        // cannot fire — this rule exists so the two loop concepts stay distinct.
        for mode in LoopMode.allCases {
            XCTAssertEqual(advanceDecision(loopMode: mode, hasActiveSectionLoop: true),
                           .stayLooping, "\(mode)")
        }
    }

    func testLoopModeKeepsItsExistingMeaningWithoutASectionLoop() {
        XCTAssertEqual(advanceDecision(loopMode: .one, hasActiveSectionLoop: false),
                       .repeatTrack)
        XCTAssertEqual(advanceDecision(loopMode: .all, hasActiveSectionLoop: false),
                       .advance)
        XCTAssertEqual(advanceDecision(loopMode: .off, hasActiveSectionLoop: false),
                       .advance)
    }

    // MARK: Crossfade curve

    func testCrossfadeEndpointsAreExact() {
        let start = Crossfade.gainPair(at: 0)
        XCTAssertEqual(start.outgoing, 1, accuracy: 1e-6)
        XCTAssertEqual(start.incoming, 0, accuracy: 1e-6)
        let end = Crossfade.gainPair(at: 1)
        XCTAssertEqual(end.outgoing, 0, accuracy: 1e-6)
        XCTAssertEqual(end.incoming, 1, accuracy: 1e-6)
    }

    func testCrossfadeHoldsConstantPower() {
        // Equal-power rather than linear, so the fade doesn't dip in perceived
        // loudness through the middle.
        for step in 0...20 {
            let (out, incoming) = Crossfade.gainPair(at: Double(step) / 20)
            XCTAssertEqual(out * out + incoming * incoming, 1, accuracy: 1e-6,
                           "sum of squares at t=\(Double(step) / 20)")
        }
    }

    func testCrossfadeIsMonotonicAndClamped() {
        var lastIncoming: Float = -1
        for step in 0...20 {
            let (_, incoming) = Crossfade.gainPair(at: Double(step) / 20)
            XCTAssertGreaterThanOrEqual(incoming, lastIncoming)
            lastIncoming = incoming
        }
        XCTAssertEqual(Crossfade.gainPair(at: -5).incoming, 0, accuracy: 1e-6)
        XCTAssertEqual(Crossfade.gainPair(at: 5).incoming, 1, accuracy: 1e-6)
    }

    // MARK: Switch mode decoding

    func testUnknownSwitchModeDecodesToASaneValueRatherThanThrowing() throws {
        // A throw anywhere inside AudioSettings makes the whole file unreadable,
        // which costs the host their entire mixer.
        let decoded = try JSONDecoder().decode(SectionSwitchMode.self,
                                               from: Data(#""somethingNew""#.utf8))
        XCTAssertEqual(decoded, .atLoopEnd)
    }

    func testKnownSwitchModesRoundTrip() throws {
        for mode in SectionSwitchMode.allCases {
            let data = try JSONEncoder().encode(mode)
            XCTAssertEqual(try JSONDecoder().decode(SectionSwitchMode.self, from: data), mode)
        }
    }

    func testUnknownLoopModeDecodesToOffRatherThanThrowing() throws {
        let decoded = try JSONDecoder().decode(LoopMode.self,
                                               from: Data(#""shuffle""#.utf8))
        XCTAssertEqual(decoded, .off)
    }
}
