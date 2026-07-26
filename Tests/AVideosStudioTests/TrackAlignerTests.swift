import XCTest
@testable import AVideosStudio

/// Pins down `LinearDriftAligner`: the anchor offset, the least-squares drift
/// fit over sparse chunk stamps, the ppm clamp, and the anchor-only fallback
/// that guest tracks always take (browser stamps carry no media time).
final class TrackAlignerTests: XCTestCase {

    private let aligner = LinearDriftAligner()

    // MARK: Fixtures

    private func track(anchor: ClockAnchor?,
                       stamps: [ChunkStamp] = []) -> TrackRecord {
        TrackRecord(participantId: "p1",
                    kind: .audio,
                    anchor: anchor,
                    chunkCount: stamps.count,
                    chunkTimeline: stamps,
                    finalized: true,
                    mimeType: "audio/webm",
                    width: nil,
                    height: nil,
                    localURL: nil)
    }

    /// Stamps on a perfect clock: session time advances exactly with media
    /// time, starting at `startSessionMs`.
    private func stamps(count: Int,
                        everyMs: Double,
                        startSessionMs: Double,
                        rate: Double,
                        includeMediaTime: Bool = true) -> [ChunkStamp] {
        (0..<count).map { i in
            let media = Double(i) * everyMs
            return ChunkStamp(chunkIndex: i,
                              mediaTimeMs: includeMediaTime ? media : nil,
                              sessionTimeMs: startSessionMs + media * rate)
        }
    }

    // MARK: Anchor handling

    func testNoAnchorYieldsIdentity() {
        let alignment = aligner.alignment(for: track(anchor: nil), takeStartSessionMs: 1_000)
        XCTAssertEqual(alignment, .identity)
    }

    func testAnchorOnlyGivesTheOffsetAndNoRateCorrection() {
        // Recording started 250ms after the take began.
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 1_250, uncertaintyMs: 12)
        let alignment = aligner.alignment(for: track(anchor: anchor), takeStartSessionMs: 1_000)
        XCTAssertEqual(alignment.offsetMs, 250, accuracy: 1e-9)
        XCTAssertEqual(alignment.rateFactor, 1, accuracy: 1e-12)
    }

    func testNegativeOffsetWhenTheTrackStartedEarly() {
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 900, uncertaintyMs: nil)
        let alignment = aligner.alignment(for: track(anchor: anchor), takeStartSessionMs: 1_000)
        XCTAssertEqual(alignment.offsetMs, -100, accuracy: 1e-9,
                       "a head trim is expressed as a negative offset")
    }

    func testNonZeroAnchorMediaTimeIsSubtracted() {
        // Anchor taken 500ms into the media, at session time 2000.
        let anchor = ClockAnchor(mediaTimeMs: 500, sessionTimeMs: 2_000, uncertaintyMs: nil)
        let alignment = aligner.alignment(for: track(anchor: anchor), takeStartSessionMs: 1_000)
        // media t=0 sits at session 1500, i.e. 500ms after the take start.
        XCTAssertEqual(alignment.offsetMs, 500, accuracy: 1e-9)
    }

    func testUncertaintyIsOptionalAndDoesNotAffectTheResult() {
        let withValue = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 1_100, uncertaintyMs: 30)
        let withoutValue = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 1_100, uncertaintyMs: nil)
        XCTAssertEqual(aligner.alignment(for: track(anchor: withValue), takeStartSessionMs: 1_000),
                       aligner.alignment(for: track(anchor: withoutValue), takeStartSessionMs: 1_000))
    }

    // MARK: Drift fit

    func testPerfectClockFitsRateOne() {
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 1_000, uncertaintyMs: nil)
        let record = track(anchor: anchor,
                           stamps: stamps(count: 10, everyMs: 30_000,
                                          startSessionMs: 1_000, rate: 1.0))
        let alignment = aligner.alignment(for: record, takeStartSessionMs: 1_000)
        XCTAssertEqual(alignment.rateFactor, 1.0, accuracy: 1e-9)
        XCTAssertEqual(alignment.offsetMs, 0, accuracy: 1e-6)
    }

    func testKnownDriftIsRecovered() {
        // Device clock runs 100ppm slow relative to the session clock: session
        // time advances 1.0001ms per media ms.
        let rate = 1.0001
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 5_000, uncertaintyMs: nil)
        let record = track(anchor: anchor,
                           stamps: stamps(count: 20, everyMs: 30_000,
                                          startSessionMs: 5_000, rate: rate))
        let alignment = aligner.alignment(for: record, takeStartSessionMs: 5_000)
        XCTAssertEqual(alignment.rateFactor, rate, accuracy: 1e-9,
                       "the least-squares slope is the drift")
        XCTAssertEqual(alignment.offsetMs, 0, accuracy: 1e-6,
                       "the fitted intercept reproduces the anchor when both agree")
    }

    func testFitDerivesTheOffsetFromTheIntercept() {
        // Stamps say media t=0 lands at session 7_400 while the take began at
        // 7_000, so the fit should report a 400ms offset.
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 7_400, uncertaintyMs: nil)
        let record = track(anchor: anchor,
                           stamps: stamps(count: 8, everyMs: 30_000,
                                          startSessionMs: 7_400, rate: 1.0))
        let alignment = aligner.alignment(for: record, takeStartSessionMs: 7_000)
        XCTAssertEqual(alignment.offsetMs, 400, accuracy: 1e-6)
    }

    func testImplausibleSlopeIsRejectedRatherThanApplied() {
        // A 10% "drift" is a data artifact (a stalled or restarted recorder),
        // not a clock: the aligner must fall back to rate 1 instead of
        // resampling audio by 10%.
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 0, uncertaintyMs: nil)
        let record = track(anchor: anchor,
                           stamps: stamps(count: 6, everyMs: 30_000,
                                          startSessionMs: 0, rate: 1.10))
        let alignment = aligner.alignment(for: record, takeStartSessionMs: 0)
        XCTAssertEqual(alignment.rateFactor, 1.0, accuracy: 1e-12)
    }

    func testRateBoundsEdges() {
        XCTAssertTrue(LinearDriftAligner.rateBounds.contains(0.999))
        XCTAssertTrue(LinearDriftAligner.rateBounds.contains(1.001))
        XCTAssertFalse(LinearDriftAligner.rateBounds.contains(0.9989))
        XCTAssertFalse(LinearDriftAligner.rateBounds.contains(1.0011))
    }

    // MARK: Degenerate input

    func testFewerThanThreeStampsFallsBackToTheAnchor() {
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 1_200, uncertaintyMs: nil)
        for count in 0...2 {
            let record = track(anchor: anchor,
                               stamps: stamps(count: count, everyMs: 30_000,
                                              startSessionMs: 9_999, rate: 1.05))
            let alignment = aligner.alignment(for: record, takeStartSessionMs: 1_000)
            XCTAssertEqual(alignment.rateFactor, 1, accuracy: 1e-12,
                           "\(count) stamps cannot support a fit")
            XCTAssertEqual(alignment.offsetMs, 200, accuracy: 1e-9,
                           "the anchor still supplies the offset")
        }
    }

    func testGuestStampsWithoutMediaTimeTakeTheAnchorOnlyPath() {
        // web/guest/recorder.js sends {chunkIndex, sessionTimeMs} only.
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 2_500, uncertaintyMs: 20)
        let record = track(anchor: anchor,
                           stamps: stamps(count: 12, everyMs: 30_000,
                                          startSessionMs: 2_500, rate: 1.0005,
                                          includeMediaTime: false))
        let alignment = aligner.alignment(for: record, takeStartSessionMs: 2_000)
        XCTAssertEqual(alignment.rateFactor, 1, accuracy: 1e-12,
                       "no media times means no fit is possible")
        XCTAssertEqual(alignment.offsetMs, 500, accuracy: 1e-9)
    }

    func testAllStampsAtTheSameMediaTimeDoesNotDivideByZero() {
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 1_000, uncertaintyMs: nil)
        let flat = (0..<5).map { i in
            ChunkStamp(chunkIndex: i, mediaTimeMs: 0, sessionTimeMs: 1_000 + Double(i))
        }
        let alignment = aligner.alignment(for: track(anchor: anchor, stamps: flat),
                                          takeStartSessionMs: 1_000)
        XCTAssertEqual(alignment.rateFactor, 1, accuracy: 1e-12)
        XCTAssertTrue(alignment.offsetMs.isFinite)
    }

    func testMixedStampsUseOnlyThoseCarryingMediaTime() {
        let anchor = ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 0, uncertaintyMs: nil)
        var mixed = stamps(count: 5, everyMs: 30_000, startSessionMs: 0, rate: 1.0)
        mixed.append(ChunkStamp(chunkIndex: 99, mediaTimeMs: nil, sessionTimeMs: 999_999))
        let alignment = aligner.alignment(for: track(anchor: anchor, stamps: mixed),
                                          takeStartSessionMs: 0)
        XCTAssertEqual(alignment.rateFactor, 1.0, accuracy: 1e-9,
                       "the media-time-less stamp must not pollute the fit")
    }
}
