import XCTest
@testable import AVideosStudio

/// Pins down the vertical timeline's geometry. Both scales must be monotonic
/// and round-trip, or a click lands on the wrong moment and a drag jumps.
final class TimelineScaleTests: XCTestCase {

    // MARK: Uniform

    func testUniformScaleIsLinear() {
        let scale = UniformTimeScale(pointsPerSecond: 40, duration: 60)
        XCTAssertEqual(scale.offset(forTime: 0), 0, accuracy: 1e-9)
        XCTAssertEqual(scale.offset(forTime: 1), 40, accuracy: 1e-9)
        XCTAssertEqual(scale.offset(forTime: 30), 1200, accuracy: 1e-9)
        XCTAssertEqual(scale.contentHeight, 2400, accuracy: 1e-9)
    }

    func testUniformScaleRoundTrips() {
        let scale = UniformTimeScale(pointsPerSecond: 25, duration: 120)
        for t in [0.0, 0.7, 13.2, 61.9, 119.5] {
            XCTAssertEqual(scale.time(forOffset: scale.offset(forTime: t)), t, accuracy: 1e-6)
        }
    }

    func testUniformScaleClampsOutsideTheProgram() {
        let scale = UniformTimeScale(pointsPerSecond: 40, duration: 10)
        XCTAssertEqual(scale.offset(forTime: -5), 0, accuracy: 1e-9)
        XCTAssertEqual(scale.time(forOffset: -100), 0, accuracy: 1e-9)
        XCTAssertEqual(scale.time(forOffset: 99_999), 10, accuracy: 1e-9)
    }

    func testUniformZoomIsClamped() {
        XCTAssertEqual(UniformTimeScale(pointsPerSecond: 5_000, duration: 10).pointsPerSecond, 400)
        XCTAssertEqual(UniformTimeScale(pointsPerSecond: 0.1, duration: 10).pointsPerSecond, 4)
    }

    // MARK: Text aligned

    /// Three words of text, each 20pt tall, spoken 0–1, 1–2, 2–3.
    private func contiguousRuns() -> [TimelineTextRun] {
        [
            TimelineTextRun(startTime: 0, endTime: 1, minY: 0, maxY: 20),
            TimelineTextRun(startTime: 1, endTime: 2, minY: 20, maxY: 40),
            TimelineTextRun(startTime: 2, endTime: 3, minY: 40, maxY: 60),
        ]
    }

    func testTextScaleGivesEachRunItsTextHeight() {
        let scale = TextAlignedScale(runs: contiguousRuns(), duration: 3)
        // Each word occupies 20pt regardless of how long it took to say.
        XCTAssertEqual(scale.offset(forTime: 0), 0, accuracy: 1e-6)
        XCTAssertEqual(scale.offset(forTime: 1), 20, accuracy: 1e-6)
        XCTAssertEqual(scale.offset(forTime: 2), 40, accuracy: 1e-6)
        XCTAssertEqual(scale.offset(forTime: 3), 60, accuracy: 1e-6)
        XCTAssertEqual(scale.contentHeight, 60, accuracy: 1e-6)
    }

    func testTextScaleIsMonotonicAndRoundTrips() {
        let scale = TextAlignedScale(runs: contiguousRuns(), duration: 3)
        var previous = -1.0
        for step in 0...30 {
            let t = Double(step) / 10
            let y = scale.offset(forTime: t)
            XCTAssertGreaterThanOrEqual(Double(y), previous, "offsets must never go backwards")
            previous = Double(y)
            XCTAssertEqual(scale.time(forOffset: y), t, accuracy: 1e-3)
        }
    }

    func testALongPauseGetsHeightInProportionToItsDuration() {
        // Two words either side of a 4-second silence.
        let runs = [
            TimelineTextRun(startTime: 0, endTime: 1, minY: 0, maxY: 20),
            TimelineTextRun(startTime: 5, endTime: 6, minY: 20, maxY: 40),
        ]
        let scale = TextAlignedScale(runs: runs, duration: 6, pauseHeightPerSecond: 18)

        let pauseHeight = scale.offset(forTime: 5) - scale.offset(forTime: 1)
        XCTAssertEqual(pauseHeight, 4 * 18, accuracy: 1e-6,
                       "a 4s silence is 4x the per-second pause height — visible and grabbable")
        // And it is genuinely bigger than a word, which is the point: you can
        // still see and trim it even though the transcript shows nothing.
        XCTAssertGreaterThan(pauseHeight, 20)
    }

    func testShortGapsBetweenWordsAreAbsorbed() {
        // A 0.1s gap is just the space between two words in a sentence; it
        // must not become a timeline block.
        let runs = [
            TimelineTextRun(startTime: 0, endTime: 1, minY: 0, maxY: 20),
            TimelineTextRun(startTime: 1.1, endTime: 2, minY: 20, maxY: 40),
        ]
        let scale = TextAlignedScale(runs: runs, duration: 2, pauseHeightPerSecond: 18)
        XCTAssertEqual(scale.contentHeight, 40, accuracy: 1e-6,
                       "no extra height for a sub-threshold gap")
    }

    func testLeadInAndTailGetProportionalHeight() {
        let runs = [TimelineTextRun(startTime: 2, endTime: 3, minY: 0, maxY: 20)]
        let scale = TextAlignedScale(runs: runs, duration: 6, pauseHeightPerSecond: 10)
        // 2s of lead-in, 20pt of word, 3s of tail.
        XCTAssertEqual(scale.offset(forTime: 0), 0, accuracy: 1e-6)
        XCTAssertEqual(scale.offset(forTime: 2), 20, accuracy: 1e-6)
        XCTAssertEqual(scale.offset(forTime: 3), 40, accuracy: 1e-6)
        XCTAssertEqual(scale.contentHeight, 70, accuracy: 1e-6)
    }

    func testEmptyMeasurementsFallBackToUniformBehaviour() {
        // Before the transcript has laid out once, the timeline must still be
        // usable rather than a blank column.
        let scale = TextAlignedScale(runs: [], duration: 10, fallbackPointsPerSecond: 40)
        XCTAssertEqual(scale.contentHeight, 400, accuracy: 1e-6)
        XCTAssertEqual(scale.offset(forTime: 5), 200, accuracy: 1e-6)
        XCTAssertEqual(scale.time(forOffset: 200), 5, accuracy: 1e-6)
    }

    func testOverlappingOrDegenerateRunsDoNotBreakInversion() {
        // Measured rectangles can share edges after rounding; a non-monotonic
        // knot list would make time(forOffset:) ambiguous.
        let runs = [
            TimelineTextRun(startTime: 0, endTime: 1, minY: 0, maxY: 20),
            TimelineTextRun(startTime: 1, endTime: 1, minY: 20, maxY: 20),   // zero length
            TimelineTextRun(startTime: 1, endTime: 2, minY: 20, maxY: 40),
        ]
        let scale = TextAlignedScale(runs: runs, duration: 2)
        var previous = -1.0
        for step in 0...20 {
            let y = scale.offset(forTime: Double(step) / 10)
            XCTAssertGreaterThanOrEqual(Double(y), previous)
            previous = Double(y)
            XCTAssertTrue(y.isFinite)
        }
        XCTAssertTrue(scale.time(forOffset: 30).isFinite)
    }

    func testOutOfRangeOffsetsClampInBothScales() {
        let scales: [TimelineScale] = [
            UniformTimeScale(pointsPerSecond: 40, duration: 3),
            TextAlignedScale(runs: contiguousRuns(), duration: 3),
        ]
        for scale in scales {
            XCTAssertGreaterThanOrEqual(scale.time(forOffset: -500), 0)
            XCTAssertLessThanOrEqual(scale.time(forOffset: 100_000), 3.001)
            XCTAssertGreaterThanOrEqual(scale.offset(forTime: -50), 0)
        }
    }
}
