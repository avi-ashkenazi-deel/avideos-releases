import XCTest
@testable import AVideosStudio

/// Pins down `EditDecisionList`: the tiling invariants, the cut/recover
/// primitives, and the source↔timeline mapping that transcript editing,
/// chapters, layout cues and export all lean on.
final class EDLTests: XCTestCase {

    // MARK: Construction

    func testInitialEDLIsOneEnabledClipCoveringTheSource() {
        let edl = EditDecisionList.initial(sourceDuration: 60)
        XCTAssertEqual(edl.clips.count, 1)
        XCTAssertEqual(edl.sourceDuration, 60, accuracy: 1e-9)
        XCTAssertEqual(edl.editedDuration, 60, accuracy: 1e-9)
        XCTAssertTrue(edl.clips[0].enabled)
        XCTAssertEqual(edl.clips[0].label, .kept)
        XCTAssertEqual(edl.clips[0].sourceRange.lowerBound, 0, accuracy: 1e-9)
    }

    func testInitialEDLFloorsDegenerateDurations() {
        // A zero-length source still has to produce a legal clip.
        let edl = EditDecisionList.initial(sourceDuration: 0)
        XCTAssertEqual(edl.clips.count, 1)
        XCTAssertGreaterThanOrEqual(edl.clips[0].duration, EditDecisionList.minimumClipDuration)
    }

    // MARK: Splitting

    func testSplitProducesTwoAdjacentClips() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        XCTAssertNotNil(edl.splitClip(at: 10))
        XCTAssertEqual(edl.clips.count, 2)
        XCTAssertEqual(edl.clips[0].sourceRange.upperBound,
                       edl.clips[1].sourceRange.lowerBound,
                       accuracy: 1e-9)
        XCTAssertEqual(edl.clips[0].sourceRange.upperBound, 10, accuracy: 1e-9)
        // Splitting never changes how much program there is.
        XCTAssertEqual(edl.editedDuration, 30, accuracy: 1e-9)
    }

    func testSplitRefusesDegenerateCuts() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        XCTAssertNil(edl.splitClip(at: 0), "a split at the very start would make a zero-length clip")
        XCTAssertNil(edl.splitClip(at: 30), "a split at the very end would make a zero-length clip")
        XCTAssertNil(edl.splitClip(at: 100), "out of range")
        XCTAssertEqual(edl.clips.count, 1)
    }

    func testSplitInheritsEnabledStateAndLabel() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(0...30, label: .cutFiller)
        XCTAssertFalse(edl.clips[0].enabled)
        edl.splitClip(at: 15)
        XCTAssertEqual(edl.clips.count, 2)
        for clip in edl.clips {
            XCTAssertFalse(clip.enabled, "a split of a cut clip stays cut")
            XCTAssertEqual(clip.label, .cutFiller, "and keeps its cut label")
        }
    }

    // MARK: Cutting

    func testDeleteRangeDisablesRatherThanRemoving() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        let changed = edl.deleteRange(10...20)
        XCTAssertEqual(changed.count, 1)
        // Nothing is thrown away: the source is still fully tiled.
        XCTAssertEqual(edl.sourceDuration, 30, accuracy: 1e-9)
        XCTAssertEqual(edl.editedDuration, 20, accuracy: 1e-9)
        assertTiling(edl, expectedSourceDuration: 30)
        let cut = edl.clips.first { !$0.enabled }
        XCTAssertEqual(cut?.label, .cutManual)
    }

    func testDeleteRangeLabelsTheCut() throws {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(5...6, label: .cutSilence)
        let cut = try XCTUnwrap(edl.clips.first { !$0.enabled })
        XCTAssertEqual(cut.label, .cutSilence)
        XCTAssertTrue(cut.label.isCut)
        XCTAssertTrue(cut.label.isAutomatedCut)
    }

    func testAdjacentCutsBothSurvive() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(10...15, label: .cutFiller)
        edl.deleteRange(15...20, label: .cutSilence)
        XCTAssertEqual(edl.editedDuration, 20, accuracy: 1e-9)
        let labels = edl.clips.filter { !$0.enabled }.map(\.label)
        XCTAssertEqual(Set(labels), Set([.cutFiller, .cutSilence]),
                       "each cut keeps its own provenance so it can be undone separately")
        assertTiling(edl, expectedSourceDuration: 30)
    }

    func testOverlappingCutPreservesTheEarlierLabel() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(10...20, label: .cutFiller)
        edl.deleteRange(15...25, label: .cutManual)
        // The already-disabled part keeps cutFiller; only new material becomes
        // a manual cut.
        let fillerTotal = edl.clips.filter { $0.label == .cutFiller }.reduce(0.0) { $0 + $1.duration }
        XCTAssertEqual(fillerTotal, 10, accuracy: 1e-9)
        XCTAssertEqual(edl.editedDuration, 15, accuracy: 1e-9)
        assertTiling(edl, expectedSourceDuration: 30)
    }

    func testCutRangeIsClampedToTheSource() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(-10...40)
        XCTAssertEqual(edl.editedDuration, 0, accuracy: 1e-9, "everything was cut")
        XCTAssertEqual(edl.sourceDuration, 30, accuracy: 1e-9)
    }

    func testZeroWidthCutIsRefused() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        XCTAssertTrue(edl.deleteRange(10...10).isEmpty)
        XCTAssertEqual(edl.editedDuration, 30, accuracy: 1e-9)
    }

    // MARK: Recovery

    func testRecoverClipRestoresProgramAndClearsTheLabel() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        let cutIDs = edl.deleteRange(10...20, label: .cutRetake)
        guard let id = cutIDs.first else { return XCTFail("expected a cut clip") }

        XCTAssertTrue(edl.recoverClip(id: id))
        XCTAssertEqual(edl.editedDuration, 30, accuracy: 1e-9)
        XCTAssertEqual(edl.clip(withID: id)?.label, .kept)
    }

    func testRecoverIsIdempotentAndRejectsUnknownIDs() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        guard let id = edl.deleteRange(10...20).first else { return XCTFail("expected a cut clip") }
        XCTAssertTrue(edl.recoverClip(id: id))
        XCTAssertFalse(edl.recoverClip(id: id), "already enabled")
        XCTAssertFalse(edl.recoverClip(id: UUID()), "unknown id")
    }

    func testSetEnabledRoundTrips() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        let id = edl.clips[0].id
        XCTAssertTrue(edl.setEnabled(false, id: id, label: .cutFlub))
        XCTAssertEqual(edl.clip(withID: id)?.label, .cutFlub)
        XCTAssertEqual(edl.editedDuration, 0, accuracy: 1e-9)
        XCTAssertTrue(edl.setEnabled(true, id: id))
        XCTAssertEqual(edl.clip(withID: id)?.label, .kept)
        XCTAssertEqual(edl.editedDuration, 30, accuracy: 1e-9)
    }

    // MARK: Time mapping

    func testMappingIsIdentityWithNoCuts() throws {
        let edl = EditDecisionList.initial(sourceDuration: 60)
        for t in [0.0, 1.5, 30.0, 59.9] {
            XCTAssertEqual(try XCTUnwrap(edl.mapSourceToTimeline(t)), t, accuracy: 1e-9)
            XCTAssertEqual(edl.mapTimelineToSource(t), t, accuracy: 1e-9)
        }
    }

    func testSourceToTimelineSkipsCutMaterial() throws {
        var edl = EditDecisionList.initial(sourceDuration: 60)
        edl.deleteRange(10...20)          // 10s removed
        // Before the cut: unchanged.
        XCTAssertEqual(try XCTUnwrap(edl.mapSourceToTimeline(5)), 5, accuracy: 1e-9)
        // After the cut: shifted earlier by the cut's duration.
        XCTAssertEqual(try XCTUnwrap(edl.mapSourceToTimeline(30)), 20, accuracy: 1e-9)
        XCTAssertEqual(edl.editedDuration, 50, accuracy: 1e-9)
    }

    func testSourceToTimelineReturnsNilInsideACut() {
        var edl = EditDecisionList.initial(sourceDuration: 60)
        edl.deleteRange(10...20)
        XCTAssertNil(edl.mapSourceToTimeline(15), "15s was cut, so it has no timeline position")
    }

    func testTimelineToSourceIsTheInverseOnEnabledMaterial() throws {
        var edl = EditDecisionList.initial(sourceDuration: 60)
        edl.deleteRange(10...20)
        edl.deleteRange(40...45)
        for source in [0.0, 5.0, 25.0, 39.0, 50.0, 59.0] {
            let timeline = try XCTUnwrap(edl.mapSourceToTimeline(source),
                                         "\(source) should survive the cuts")
            XCTAssertEqual(edl.mapTimelineToSource(timeline), source, accuracy: 1e-6,
                           "round trip through the edited timeline must land back on the same frame")
        }
    }

    func testTimelineToSourceClampsOutOfRangeInput() {
        var edl = EditDecisionList.initial(sourceDuration: 60)
        edl.deleteRange(10...20)
        XCTAssertEqual(edl.mapTimelineToSource(-5), 0, accuracy: 1e-9)
        let end = edl.mapTimelineToSource(9_999)
        XCTAssertLessThanOrEqual(end, 60 + 1e-9)
        XCTAssertGreaterThan(end, 0)
    }

    func testNearestEnabledSourceTime() {
        var edl = EditDecisionList.initial(sourceDuration: 60)
        edl.deleteRange(10...20)
        // Already enabled: identity.
        XCTAssertEqual(edl.nearestEnabledSourceTime(to: 5), 5, accuracy: 1e-9)
        // Inside the cut: snapped to a surviving boundary.
        let snapped = edl.nearestEnabledSourceTime(to: 15)
        XCTAssertNotNil(edl.mapSourceToTimeline(snapped),
                        "the snapped time must itself be enabled")
    }

    func testEnabledSegmentsAreOrderedAndContiguousOnTheTimeline() {
        var edl = EditDecisionList.initial(sourceDuration: 60)
        edl.deleteRange(10...20)
        edl.deleteRange(40...45)
        let segments = edl.enabledSegments()
        XCTAssertFalse(segments.isEmpty)
        var expectedStart = 0.0
        for segment in segments {
            XCTAssertEqual(segment.timelineStart, expectedStart, accuracy: 1e-9)
            XCTAssertTrue(segment.clip.enabled)
            expectedStart += segment.clip.duration
        }
        XCTAssertEqual(expectedStart, edl.editedDuration, accuracy: 1e-9)
    }

    // MARK: Hygiene

    func testCoalesceMergesLikeNeighboursAndKeepsTheSourceIntact() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.splitClip(at: 10)
        edl.splitClip(at: 20)
        XCTAssertEqual(edl.clips.count, 3)
        edl.coalesce()
        XCTAssertEqual(edl.clips.count, 1, "three identical enabled clips are one clip")
        XCTAssertEqual(edl.sourceDuration, 30, accuracy: 1e-9)
    }

    func testCoalesceKeepsDistinctCutsApart() {
        var edl = EditDecisionList.initial(sourceDuration: 30)
        edl.deleteRange(10...15, label: .cutFiller)
        edl.deleteRange(15...20, label: .cutSilence)
        let before = edl.clips.count
        edl.coalesce()
        XCTAssertEqual(edl.clips.count, before,
                       "different cut labels must not be merged — that would lose recoverability")
    }

    // MARK: Layout cues

    func testLayoutCueLookupIsOrderedAndUsesTheFallback() {
        let cues = [
            LayoutCue(atTime: 10, layout: .sideBySide),
            LayoutCue(atTime: 5, layout: .grid),
            LayoutCue(atTime: 20, layout: .verticalStacked),
        ]
        // Before the first cue nothing has been chosen yet.
        XCTAssertEqual(cues.layout(at: 0, fallback: .activeSpeaker), .activeSpeaker)
        // Unsorted input must still resolve in time order.
        XCTAssertEqual(cues.layout(at: 7), .grid)
        XCTAssertEqual(cues.layout(at: 10), .sideBySide, "a cue applies from its own instant")
        XCTAssertEqual(cues.layout(at: 15), .sideBySide)
        XCTAssertEqual(cues.layout(at: 999), .verticalStacked)
    }

    func testEmptyCueListAlwaysYieldsTheFallback() {
        let cues: [LayoutCue] = []
        XCTAssertEqual(cues.layout(at: 42, fallback: .grid), .grid)
    }

    // MARK: Helpers

    /// Tiling is no longer a global EDL invariant — clips can be reordered,
    /// trimmed and duplicated (see `SequenceEDLTests`). But **cutting alone**
    /// still preserves it, because a cut only ever splits and disables. These
    /// tests assert that property for cut-only workflows, which is what
    /// guarantees a straight recording still behaves exactly as it used to.
    private func assertTiling(_ edl: EditDecisionList,
                              expectedSourceDuration: Double,
                              file: StaticString = #filePath,
                              line: UInt = #line) {
        XCTAssertFalse(edl.clips.isEmpty, "an EDL always has at least one clip", file: file, line: line)
        XCTAssertEqual(edl.clips[0].sourceRange.lowerBound, 0, accuracy: 1e-9, file: file, line: line)
        for (a, b) in zip(edl.clips, edl.clips.dropFirst()) {
            XCTAssertEqual(a.sourceRange.upperBound, b.sourceRange.lowerBound, accuracy: 1e-9,
                           "gap or overlap between clips", file: file, line: line)
            XCTAssertGreaterThanOrEqual(a.duration, EditDecisionList.minimumClipDuration,
                                        file: file, line: line)
        }
        XCTAssertEqual(edl.clips.last?.sourceRange.upperBound ?? -1,
                       expectedSourceDuration, accuracy: 1e-9, file: file, line: line)
    }
}
