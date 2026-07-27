import XCTest
@testable import AVideosStudio

/// Pins the composition placement arithmetic — the part of building a
/// composition that has no AVFoundation in it, and therefore the part that can
/// be checked here rather than on a Mac.
final class PlacementTests: XCTestCase {

    private func clip(_ start: Double, _ end: Double) -> Clip {
        Clip(sourceRange: start...end)
    }

    private func segments(_ ranges: [(Double, Double)]) -> [(clip: Clip, timelineStart: Double)] {
        var out: [(clip: Clip, timelineStart: Double)] = []
        var acc = 0.0
        for (start, end) in ranges {
            out.append((clip(start, end), acc))
            acc += end - start
        }
        return out
    }

    // MARK: The existing behaviour, which must not change

    func testWholeSegmentInsertsWhenTheFileCoversIt() {
        let result = MediaPlacement.placements(segments: segments([(0, 10)]),
                                               assetDuration: 60)
        XCTAssertEqual(result, [.insert(source: 0...10, at: 0)])
    }

    func testConsecutiveSegmentsPackButtToButt() {
        let result = MediaPlacement.placements(segments: segments([(0, 10), (20, 25)]),
                                               assetDuration: 60)
        XCTAssertEqual(result, [.insert(source: 0...10, at: 0),
                                .insert(source: 20...25, at: 10)])
    }

    func testShortFilePadsTheTail() {
        // The existing case: a participant who stopped recording early still
        // has to occupy the full segment, or the tracks fall out of alignment.
        let result = MediaPlacement.placements(segments: segments([(0, 10)]),
                                               assetDuration: 4)
        XCTAssertEqual(result, [.insert(source: 0...4, at: 0),
                                .empty(4...10)])
    }

    func testFileEntirelyShorterThanTheProgramIsAllEmptyAfterItRunsOut() {
        let result = MediaPlacement.placements(segments: segments([(20, 30)]),
                                               assetDuration: 5)
        XCTAssertEqual(result, [.empty(0...10)])
    }

    func testReorderedAndDuplicatedSegmentsEachGetPlaced() {
        // Sequence EDLs can repeat a moment; each occurrence places separately.
        let result = MediaPlacement.placements(
            segments: [(clip(30, 35), 0), (clip(0, 10), 5), (clip(30, 35), 15)],
            assetDuration: 60)
        XCTAssertEqual(result, [.insert(source: 30...35, at: 0),
                                .insert(source: 0...10, at: 5),
                                .insert(source: 30...35, at: 15)])
    }

    // MARK: New: a source that doesn't start with the session

    func testPositiveSourceOffsetPadsTheHead() {
        // An external file that started rolling 4s after the session did: the
        // first 4s of the program has no media from it.
        let result = MediaPlacement.placements(segments: segments([(0, 10)]),
                                               sourceOffset: 4,
                                               assetDuration: 60)
        XCTAssertEqual(result, [.empty(0...4),
                                .insert(source: 0...6, at: 4)])
    }

    func testNegativeSourceOffsetTrimsTheHead() {
        // A file that started 4s *before* the session: we skip into it.
        let result = MediaPlacement.placements(segments: segments([(0, 10)]),
                                               sourceOffset: -4,
                                               assetDuration: 60)
        XCTAssertEqual(result, [.insert(source: 4...14, at: 0)])
    }

    func testOffsetAndShortFilePadBothEnds() {
        let result = MediaPlacement.placements(segments: segments([(0, 10)]),
                                               sourceOffset: 2,
                                               assetDuration: 5)
        XCTAssertEqual(result, [.empty(0...2),
                                .insert(source: 0...5, at: 2),
                                .empty(7...10)])
    }

    func testSourceStartingAfterTheSegmentEndsIsAllEmpty() {
        let result = MediaPlacement.placements(segments: segments([(0, 10)]),
                                               sourceOffset: 30,
                                               assetDuration: 60)
        XCTAssertEqual(result, [.empty(0...10)])
    }

    // MARK: New: timeline offset, for intro bookends

    func testTimelineOffsetShiftsEverythingLater() {
        let result = MediaPlacement.placements(segments: segments([(0, 10), (20, 25)]),
                                               assetDuration: 60,
                                               timelineOffset: 4)
        XCTAssertEqual(result, [.insert(source: 0...10, at: 4),
                                .insert(source: 20...25, at: 14)])
    }

    func testTimelineOffsetZeroIsTheIdentity() {
        let plain = MediaPlacement.placements(segments: segments([(0, 10), (20, 25)]),
                                              assetDuration: 7)
        let offset = MediaPlacement.placements(segments: segments([(0, 10), (20, 25)]),
                                               assetDuration: 7,
                                               timelineOffset: 0)
        XCTAssertEqual(plain, offset, "the default path must be untouched by the new parameter")
    }

    func testEmptySegmentsProduceNothing() {
        XCTAssertTrue(MediaPlacement.placements(segments: [], assetDuration: 60).isEmpty)
    }
}
