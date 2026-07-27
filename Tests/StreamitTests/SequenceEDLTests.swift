import XCTest
@testable import Streamit

/// Pins down the sequence behaviour of `EditDecisionList`: reordering,
/// trimming, duplication, and the one-to-many source→timeline mapping that
/// falls out of letting a moment play more than once.
///
/// `EDLTests` covers the cut/recover semantics that predate sequencing and
/// must keep working unchanged; this file covers what sequencing adds.
final class SequenceEDLTests: XCTestCase {

    /// Three back-to-back segments over a 30s recording: 0–10, 10–20, 20–30.
    private func threeSegments() -> EditDecisionList {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.splitClip(at: 10)
        edl.splitClip(at: 20)
        return edl
    }

    // MARK: Source duration

    func testSourceDurationSurvivesReordering() {
        var edl = threeSegments()
        let first = edl.clips[0].id
        edl.move(clipID: first, toIndex: 2)
        XCTAssertEqual(edl.sourceDuration, 30, accuracy: 1e-9,
                       "the recording is still 30s however the program is arranged")
    }

    func testSourceDurationSurvivesTrimmingTheLastSegment() {
        var edl = threeSegments()
        let last = edl.clips[2].id
        edl.trim(clipID: last, to: 20...25)
        XCTAssertEqual(edl.sourceDuration, 30, accuracy: 1e-9,
                       "trimming the program does not shorten the recording")
    }

    func testEDLWithoutAStoredDurationFallsBackToItsExtent() throws {
        // Pre-sequence documents carry no stored duration. Built by stripping
        // the key from real encoded output rather than hand-writing JSON,
        // since ClosedRange's encoding is an unkeyed pair, not an object.
        let edl = EditDecisionList(clips: [Clip(sourceRange: 0...42)])
        XCTAssertEqual(edl.sourceDuration, 42, accuracy: 1e-9,
                       "with no stored duration, the furthest clip defines the extent")

        let encoded = try JSONEncoder().encode(EditDecisionList.initial(sourceDuration: 42))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "storedSourceDuration")
        let legacy = try JSONDecoder().decode(
            EditDecisionList.self,
            from: try JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(legacy.sourceDuration, 42, accuracy: 1e-9,
                       "an old document still reports the right recording length")
        XCTAssertEqual(legacy.editedDuration, 42, accuracy: 1e-9)
    }

    // MARK: Move

    func testMoveReordersTheProgramWithoutChangingItsLength() {
        var edl = threeSegments()
        let before = edl.editedDuration
        let first = edl.clips[0].id

        XCTAssertTrue(edl.move(clipID: first, toIndex: 2))
        XCTAssertEqual(edl.clips[2].id, first, "the moved segment now plays last")
        XCTAssertEqual(edl.editedDuration, before, accuracy: 1e-9,
                       "reordering moves material, it doesn't add or remove any")
    }

    func testMovedSegmentPlaysAtItsNewTimelinePosition() {
        var edl = threeSegments()
        let first = edl.clips[0].id          // source 0–10
        edl.move(clipID: first, toIndex: 2)

        // Program is now 10–20, 20–30, 0–10.
        XCTAssertEqual(edl.mapTimelineToSource(0), 10, accuracy: 1e-9)
        XCTAssertEqual(edl.mapTimelineToSource(25), 5, accuracy: 1e-9,
                       "25s into the program is 5s into the segment that used to be first")
    }

    func testMoveIsClampedAndReportsWhetherAnythingChanged() {
        var edl = threeSegments()
        let first = edl.clips[0].id
        XCTAssertTrue(edl.move(clipID: first, toIndex: 99), "out-of-range clamps to the end")
        XCTAssertEqual(edl.clips.last?.id, first)
        XCTAssertFalse(edl.move(clipID: first, toIndex: 99), "already there — nothing changed")
        XCTAssertFalse(edl.move(clipID: UUID(), toIndex: 0), "unknown id")
    }

    func testEnabledSegmentsFollowArrayOrderNotSourceOrder() {
        var edl = threeSegments()
        edl.move(clipID: edl.clips[0].id, toIndex: 2)
        let segments = edl.enabledSegments()
        XCTAssertEqual(segments.map(\.clip.sourceRange.lowerBound), [10, 20, 0],
                       "the composition lays segments down in program order")
        // Timeline starts still accumulate correctly.
        XCTAssertEqual(segments.map(\.timelineStart), [0, 10, 20])
    }

    // MARK: Trim (drag to extend)

    func testTrimShortensASegment() {
        var edl = threeSegments()
        let middle = edl.clips[1].id
        XCTAssertTrue(edl.trim(clipID: middle, to: 12...18))
        XCTAssertEqual(edl.clip(withID: middle)?.duration ?? 0, 6, accuracy: 1e-9)
        XCTAssertEqual(edl.editedDuration, 26, accuracy: 1e-9)
    }

    func testTrimCanExtendBackIntoMaterialACutHadTaken() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(10...20)
        // The surviving tail is 20–30; drag its head back to 15.
        guard let tail = edl.clips.last?.id else { return XCTFail("expected a tail clip") }
        XCTAssertTrue(edl.trim(clipID: tail, to: 15...30))
        XCTAssertEqual(edl.clip(withID: tail)?.sourceRange.lowerBound ?? -1, 15, accuracy: 1e-9,
                       "extending is not limited to what the clip covered when it was made")
        XCTAssertEqual(edl.editedDuration, 25, accuracy: 1e-9)
    }

    func testTrimIsClampedToTheRecordingAndToAMinimumLength() {
        var edl = threeSegments()
        let middle = edl.clips[1].id
        XCTAssertTrue(edl.trim(clipID: middle, to: -50...500))
        let trimmed = edl.clip(withID: middle)
        XCTAssertEqual(trimmed?.sourceRange.lowerBound ?? -1, 0, accuracy: 1e-9)
        XCTAssertEqual(trimmed?.sourceRange.upperBound ?? -1, 30, accuracy: 1e-9)

        XCTAssertFalse(edl.trim(clipID: middle, to: 10...10), "zero-length is refused")
        XCTAssertFalse(edl.trim(clipID: UUID(), to: 0...5), "unknown id")
    }

    // MARK: Duplicate and remove

    func testDuplicatePlacesACopyRightAfterTheOriginal() throws {
        var edl = threeSegments()
        let middle = edl.clips[1]
        let copyID = try XCTUnwrap(edl.duplicate(clipID: middle.id))

        XCTAssertEqual(edl.clips.count, 4)
        XCTAssertEqual(edl.clips[2].id, copyID)
        XCTAssertNotEqual(copyID, middle.id, "the copy is its own segment")
        XCTAssertEqual(edl.clips[2].sourceRange, middle.sourceRange)
        XCTAssertEqual(edl.editedDuration, 40, accuracy: 1e-9, "10s now plays twice")
    }

    func testADuplicatedMomentHasTwoTimelinePositions() throws {
        var edl = threeSegments()
        _ = try XCTUnwrap(edl.duplicate(clipID: edl.clips[1].id))

        // Source 15 sits in the middle segment, which now plays twice.
        let positions = edl.timelinePositions(ofSource: 15)
        XCTAssertEqual(positions.count, 2, "the same moment plays at two points in the program")
        XCTAssertEqual(positions[0], 15, accuracy: 1e-9)
        XCTAssertEqual(positions[1], 25, accuracy: 1e-9)

        XCTAssertEqual(edl.mapSourceToTimeline(15), positions.first,
                       "the single-answer mapping is the first occurrence")
    }

    func testTimelinePositionsIsEmptyForCutMaterial() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(10...20)
        XCTAssertTrue(edl.timelinePositions(ofSource: 15).isEmpty)
        XCTAssertNil(edl.mapSourceToTimeline(15))
    }

    func testRemoveDeletesOutrightAndRefusesToEmptyTheSequence() throws {
        var edl = threeSegments()
        let copyID = try XCTUnwrap(edl.duplicate(clipID: edl.clips[0].id))
        XCTAssertTrue(edl.remove(clipID: copyID))
        XCTAssertEqual(edl.clips.count, 3)
        XCTAssertNil(edl.clip(withID: copyID), "removal is not recoverable, unlike a cut")

        var single = EditDecisionList.initial(sourceDuration: 10)
        XCTAssertFalse(single.remove(clipID: single.clips[0].id),
                       "the sequence must never be emptied")
    }

    // MARK: Cutting a repeated moment

    func testCuttingAMomentRemovesEveryOccurrence() throws {
        var edl = threeSegments()
        _ = try XCTUnwrap(edl.duplicate(clipID: edl.clips[1].id))
        XCTAssertEqual(edl.timelinePositions(ofSource: 15).count, 2)

        edl.deleteRange(14...16)
        XCTAssertTrue(edl.timelinePositions(ofSource: 15).isEmpty,
                      "cutting a word must not leave a copy of it playing elsewhere")
    }

    // MARK: Split at the playhead

    func testSplitAtTimelineTimeIsUnambiguousWithDuplicates() throws {
        var edl = threeSegments()
        _ = try XCTUnwrap(edl.duplicate(clipID: edl.clips[1].id))
        let countBefore = edl.clips.count

        // Timeline 25 is inside the *second* occurrence of source 10–20.
        XCTAssertNotNil(edl.splitClip(atTimelineTime: 25))
        XCTAssertEqual(edl.clips.count, countBefore + 1)
        XCTAssertEqual(edl.editedDuration, 40, accuracy: 1e-9, "splitting changes nothing audible")
        // The split landed in the copy (index 2), not the original (index 1).
        XCTAssertEqual(edl.clips[1].duration, 10, accuracy: 1e-9)
        XCTAssertEqual(edl.clips[2].duration, 5, accuracy: 1e-9)
    }

    func testSplitAtTimelineTimeOutsideTheProgramIsANoOp() {
        var edl = threeSegments()
        XCTAssertNil(edl.splitClip(atTimelineTime: 9_999))
        XCTAssertEqual(edl.clips.count, 3)
    }

    // MARK: Transcript agreement

    func testTranscriptWordsRepeatWhenTheirSegmentDoes() throws {
        // One word per second across 30s.
        let words = (0..<30).map { i in
            Word(text: "w\(i)", start: Double(i) + 0.1, end: Double(i) + 0.9,
                 confidence: 1, trackId: "t1")
        }
        let transcript = Transcript(words: words)

        var edl = threeSegments()
        _ = try XCTUnwrap(edl.duplicate(clipID: edl.clips[1].id))

        let enabled = transcript.enabledWords(edl: edl)
        let occurrences = enabled.filter { $0.index == 15 }
        XCTAssertEqual(occurrences.count, 2, "word 15 is spoken twice in the edited program")

        // And the whole list stays monotonic in timeline time, which caption
        // rendering and the speaker timeline both depend on.
        let starts = enabled.map(\.timelineStart)
        XCTAssertEqual(starts, starts.sorted(), "enabledWords must be in program order")
    }

    func testTranscriptFollowsAReorderedProgram() {
        let words = (0..<30).map { i in
            Word(text: "w\(i)", start: Double(i) + 0.1, end: Double(i) + 0.9,
                 confidence: 1, trackId: "t1")
        }
        let transcript = Transcript(words: words)

        var edl = threeSegments()
        edl.move(clipID: edl.clips[0].id, toIndex: 2)   // 0–10 now plays last

        let enabled = transcript.enabledWords(edl: edl)
        XCTAssertEqual(enabled.first?.index, 10, "the program now opens on word 10")
        XCTAssertEqual(enabled.last?.index, 9, "and closes on word 9")
        let starts = enabled.map(\.timelineStart)
        XCTAssertEqual(starts, starts.sorted())
    }

    func testWordIndicesInSourceRangeIsTheContiguousRun() {
        let words = (0..<30).map { i in
            Word(text: "w\(i)", start: Double(i) + 0.1, end: Double(i) + 0.9,
                 confidence: 1, trackId: "t1")
        }
        let transcript = Transcript(words: words)
        // Word i spans i+0.1…i+0.9, so its midpoint is i+0.5. For 10...20 the
        // qualifying midpoints are 10.5 through 19.5 — word 20's midpoint of
        // 20.5 falls outside.
        let range = transcript.wordIndices(inSourceRange: 10...20)
        XCTAssertEqual(range.lowerBound, 10)
        XCTAssertEqual(range.upperBound, 20)
        XCTAssertTrue(transcript.wordIndices(inSourceRange: 100...200).isEmpty)
    }

    // MARK: Persistence

    func testReorderedEDLRoundTrips() throws {
        var edl = threeSegments()
        edl.move(clipID: edl.clips[0].id, toIndex: 2)
        _ = edl.duplicate(clipID: edl.clips[0].id)

        let data = try JSONEncoder().encode(edl)
        let decoded = try JSONDecoder().decode(EditDecisionList.self, from: data)
        XCTAssertEqual(decoded, edl)
        XCTAssertEqual(decoded.clips.map(\.sourceRange.lowerBound),
                       edl.clips.map(\.sourceRange.lowerBound),
                       "program order must survive a save/load cycle")
        XCTAssertEqual(decoded.sourceDuration, 30, accuracy: 1e-9)
    }
}
