import XCTest
@testable import Streamit

/// Pins the volume envelope: the cut micro-fades, ducking under external
/// audio, and — the whole reason this type exists — what happens where the two
/// overlap.
final class VolumeAutomationTests: XCTestCase {

    private let crossfade = 0.015

    /// The envelope's value at `time`, interpolated the way AVFoundation will
    /// read it.
    ///
    /// This used to look up an exact breakpoint and return nil otherwise, which
    /// made every `volume(...)!` in this file a trap for any question asked
    /// mid-segment — a plateau between two breakpoints has a perfectly
    /// well-defined level, and asking for it should not crash the suite.
    /// Exact breakpoints still return their own value untouched.
    private func volume(_ points: [VolumeAutomation.Point], at time: Double) -> Float? {
        guard let first = points.first, let last = points.last else { return nil }
        if let exact = points.first(where: { abs($0.time - time) < 1e-9 }) { return exact.volume }
        if time <= first.time { return first.volume }
        if time >= last.time { return last.volume }
        guard let index = points.firstIndex(where: { $0.time > time }), index > 0 else { return nil }
        let a = points[index - 1], b = points[index]
        let progress = (time - a.time) / (b.time - a.time)
        return a.volume + (b.volume - a.volume) * Float(progress)
    }

    // MARK: Cut notches — today's behaviour, unchanged

    func testJoinsGetAVDownToSilence() {
        let points = VolumeAutomation.envelope(base: 1, joins: [10],
                                               ducks: [], crossfadeDuration: crossfade,
                                               duration: 30)
        XCTAssertEqual(volume(points, at: 10), 0, "a cut boundary reaches silence exactly")
        XCTAssertEqual(volume(points, at: 10 - crossfade / 2), 1)
        XCTAssertEqual(volume(points, at: 10 + crossfade / 2), 1)
    }

    func testNotchesScaleWithTheTrackLevel() {
        // The fade must return to the track's own gain, not to unity — that
        // was the point of threading gain through in the first place.
        let points = VolumeAutomation.envelope(base: 0.5, joins: [10],
                                               ducks: [], crossfadeDuration: crossfade,
                                               duration: 30)
        XCTAssertEqual(volume(points, at: 10 - crossfade / 2), 0.5)
        XCTAssertEqual(volume(points, at: 10), 0)
    }

    func testNoJoinsAndNoDucksIsAFlatEnvelope() {
        let points = VolumeAutomation.envelope(base: 0.8, joins: [],
                                               ducks: [], crossfadeDuration: crossfade,
                                               duration: 30)
        XCTAssertTrue(points.allSatisfy { $0.volume == 0.8 })
    }

    func testASilentTrackProducesASinglePoint() {
        let points = VolumeAutomation.envelope(base: 0, joins: [10],
                                               ducks: [window(20, 25)],
                                               crossfadeDuration: crossfade, duration: 30)
        XCTAssertEqual(points, [VolumeAutomation.Point(time: 0, volume: 0)],
                       "muted or non-soloed: ducking must never resurrect it")
    }

    // MARK: Ducking

    private func window(_ start: Double, _ end: Double,
                        _ settings: DuckSettings = .standard) -> VolumeAutomation.DuckWindow {
        VolumeAutomation.DuckWindow(start: start, end: end, settings: settings)
    }

    func testDuckedLevelIsTheStatedAttenuation() {
        let points = VolumeAutomation.envelope(base: 1, joins: [],
                                               ducks: [window(10, 15)],
                                               crossfadeDuration: crossfade, duration: 30)
        let expected = Float(pow(10, -12.0 / 20))
        XCTAssertEqual(volume(points, at: 10)!, expected, accuracy: 1e-6)
        XCTAssertEqual(volume(points, at: 15)!, expected, accuracy: 1e-6)
    }

    func testTheAttackLandsBeforeTheClipStarts() {
        // Anticipatory: full level at the start of the ramp, already down when
        // the external audio actually arrives.
        let points = VolumeAutomation.envelope(base: 1, joins: [],
                                               ducks: [window(10, 15)],
                                               crossfadeDuration: crossfade, duration: 30)
        XCTAssertEqual(volume(points, at: 10 - DuckSettings.standard.attack)!, 1, accuracy: 1e-6)
    }

    func testTheReleaseRecoversAfterTheClipEnds() {
        let points = VolumeAutomation.envelope(base: 1, joins: [],
                                               ducks: [window(10, 15)],
                                               crossfadeDuration: crossfade, duration: 30)
        XCTAssertEqual(volume(points, at: 15 + DuckSettings.standard.release)!, 1, accuracy: 1e-6)
    }

    func testDuckingScalesWithTheTrackLevel() {
        // A track already at −6 dB ducks to −18 dB, not to −12 dB absolute.
        // Sampled mid-plateau (t=12, inside the 10…15 window) rather than at a
        // breakpoint, which is where the scaling is least ambiguous.
        let base: Float = 0.5
        let points = VolumeAutomation.envelope(base: base, joins: [],
                                               ducks: [window(10, 15)],
                                               crossfadeDuration: crossfade, duration: 30)
        XCTAssertEqual(volume(points, at: 12)!, base * Float(pow(10, -12.0 / 20)), accuracy: 1e-6)
    }

    // MARK: Where the two meet — the reason this type exists

    func testACutInsideADuckResolvesToSilenceNotToTheDuckedLevel() {
        let points = VolumeAutomation.envelope(base: 1, joins: [12],
                                               ducks: [window(10, 15)],
                                               crossfadeDuration: crossfade, duration: 30)
        XCTAssertEqual(volume(points, at: 12), 0,
                       "deepest attenuation wins, so the notch survives inside the duck")
    }

    func testTheDuckSurvivesEitherSideOfACutInsideIt() {
        let points = VolumeAutomation.envelope(base: 1, joins: [12],
                                               ducks: [window(10, 15)],
                                               crossfadeDuration: crossfade, duration: 30)
        let ducked = Float(pow(10, -12.0 / 20))
        XCTAssertEqual(volume(points, at: 12 - crossfade / 2)!, ducked, accuracy: 1e-6,
                       "the notch returns to the DUCKED level, not to full")
    }

    // MARK: Merging

    func testNearbyWindowsMergeSoTheConversationDoesNotPump() {
        let merged = VolumeAutomation.merged([window(10, 12), window(12.2, 14)])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged.first?.start, 10)
        XCTAssertEqual(merged.first?.end, 14)
    }

    func testDistantWindowsStaySeparate() {
        let merged = VolumeAutomation.merged([window(10, 12), window(30, 32)])
        XCTAssertEqual(merged.count, 2)
    }

    func testMergingIsOrderIndependent() {
        let merged = VolumeAutomation.merged([window(30, 32), window(10, 12)])
        XCTAssertEqual(merged.map(\.start), [10, 30])
    }

    // MARK: Shape guarantees

    func testTimesStrictlyIncreaseAndNeverRepeat() {
        // What makes the emitted ramps non-overlapping by construction.
        let points = VolumeAutomation.envelope(
            base: 1, joins: [5, 10, 10.001, 20],
            ducks: [window(9, 11), window(19.5, 21)],
            crossfadeDuration: crossfade, duration: 30)
        for (previous, next) in zip(points, points.dropFirst()) {
            XCTAssertLessThan(previous.time, next.time)
        }
    }

    func testEverythingIsClampedIntoTheProgram() {
        let points = VolumeAutomation.envelope(base: 1, joins: [0.001],
                                               ducks: [window(0, 2)],
                                               crossfadeDuration: crossfade, duration: 10)
        XCTAssertGreaterThanOrEqual(points.first!.time, 0)
        XCTAssertLessThanOrEqual(points.last!.time, 10)
    }

    func testADuckAtTimeZeroStartsAlreadyDucked() {
        // No room for a lead-in; the first point must be the ducked value
        // rather than full level followed by a ramp that fights it.
        let points = VolumeAutomation.envelope(base: 1, joins: [],
                                               ducks: [window(0, 5)],
                                               crossfadeDuration: crossfade, duration: 30)
        XCTAssertEqual(points.first!.volume, Float(pow(10, -12.0 / 20)), accuracy: 1e-6)
    }

    func testNoDuckingLeavesTheJoinOutputIdenticalToTheOldBehaviour() {
        // Regression guard for the refactor: base at the edges, zero at the
        // join, nothing else moving.
        let points = VolumeAutomation.envelope(base: 1, joins: [10, 20],
                                               ducks: [], crossfadeDuration: crossfade,
                                               duration: 30)
        XCTAssertEqual(volume(points, at: 0), 1)
        XCTAssertEqual(volume(points, at: 10), 0)
        XCTAssertEqual(volume(points, at: 20), 0)
        XCTAssertEqual(volume(points, at: 30), 1)
    }
}
