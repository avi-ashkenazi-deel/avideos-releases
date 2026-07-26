import XCTest
@testable import AVideosStudio

/// Pins down the text side of AI take selection: token normalization, the
/// anchor-based aligner, and the deterministic take signals Claude is given
/// alongside the words. All synthetic — no audio, no network.
final class ScriptAlignerTests: XCTestCase {

    // MARK: Normalization

    func testNormalizeTokenLowercasesAndStripsPunctuation() {
        XCTAssertEqual(ScriptAligner.normalizeToken("Hello,"), "hello")
        XCTAssertEqual(ScriptAligner.normalizeToken("WORLD!"), "world")
        XCTAssertEqual(ScriptAligner.normalizeToken("...quiet..."), "quiet")
    }

    func testNormalizeTokenFoldsTypographicApostrophes() {
        // A curly apostrophe from a pasted script must match a straight one
        // from the transcriber, or every contraction breaks alignment.
        XCTAssertEqual(ScriptAligner.normalizeToken("don’t"),
                       ScriptAligner.normalizeToken("don't"))
    }

    func testTranscriptTokensMaskDisfluenciesWithoutLosingIndices() {
        let transcript = makeTranscript([
            ("so", false), ("um", true), ("the", false), ("point", false),
        ])
        let tokens = ScriptAligner.transcriptTokens(transcript)
        XCTAssertEqual(tokens.count, 4, "indices must line up with words 1:1")
        XCTAssertEqual(tokens, ["so", "<disfluency>", "the", "point"])
        XCTAssertNotEqual(tokens[1], "um",
                          "a disfluency must never match a script token")
    }

    // MARK: Alignment

    func testEmptyInputYieldsNoSpans() {
        XCTAssertTrue(ScriptAligner.align(scriptTokens: [], transcriptTokens: ["a"]).isEmpty)
        XCTAssertTrue(ScriptAligner.align(scriptTokens: ["a"], transcriptTokens: []).isEmpty)
    }

    func testCleanSingleTakeAlignsAsOneSpan() {
        let script = ScriptAligner.normalize(
            "today we are talking about pricing and how we think about it")
        let spans = ScriptAligner.align(scriptTokens: script, transcriptTokens: script)
        XCTAssertEqual(spans.count, 1, "a verbatim read is one monotonic span")
        let span = try? XCTUnwrap(spans.first)
        XCTAssertEqual(span?.scriptTokenRange.lowerBound, 0)
        XCTAssertEqual(span?.transcriptWordRange.lowerBound, 0)
    }

    func testShortInputBelowTheShingleWidthProducesNoAnchors() {
        // The aligner anchors on 4-grams, so three words cannot anchor.
        let tokens = ["one", "two", "three"]
        XCTAssertTrue(ScriptAligner.align(scriptTokens: tokens, transcriptTokens: tokens).isEmpty)
    }

    func testTwoTakesOfTheSameLineProduceTwoSpansOverTheSameScriptRange() {
        let script = ScriptAligner.normalize(
            "the most important thing about pricing is that it signals value")
        // The speaker reads it twice in a row.
        let spoken = script + script
        let spans = ScriptAligner.align(scriptTokens: script, transcriptTokens: spoken)
        XCTAssertGreaterThanOrEqual(spans.count, 2,
                                    "each read of the same script range is its own span — that is what makes it a retake")
        // Later spans sit later in the transcript.
        let starts = spans.map(\.transcriptWordRange.lowerBound)
        XCTAssertEqual(starts, starts.sorted(), "spans are reported in transcript order")
    }

    func testUnscriptedMaterialDoesNotAlign() {
        let script = ScriptAligner.normalize("we will talk about pricing today in detail")
        let spoken = ScriptAligner.normalize("completely different words nobody wrote down anywhere")
        XCTAssertTrue(ScriptAligner.align(scriptTokens: script, transcriptTokens: spoken).isEmpty,
                      "an ad-lib must not be forced onto the script")
    }

    func testSpansAreWithinBounds() {
        let script = ScriptAligner.normalize(
            "one two three four five six seven eight nine ten eleven twelve")
        let spoken = script
        for span in ScriptAligner.align(scriptTokens: script, transcriptTokens: spoken) {
            XCTAssertGreaterThanOrEqual(span.scriptTokenRange.lowerBound, 0)
            XCTAssertLessThanOrEqual(span.scriptTokenRange.upperBound, script.count)
            XCTAssertGreaterThanOrEqual(span.transcriptWordRange.lowerBound, 0)
            XCTAssertLessThanOrEqual(span.transcriptWordRange.upperBound, spoken.count)
        }
    }

    // MARK: Take signals

    func testTakeSignalsCountDisfluencies() throws {
        let words: [(String, Bool)] = [
            ("the", false), ("um", true), ("point", false), ("is", false),
            ("uh", true), ("clear", false),
        ]
        let transcript = makeTranscript(words)
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<4,
                                             transcriptWordRange: 0..<6)
        let takes = TakeDetector.takes(spans: [span],
                                       transcript: transcript,
                                       scriptTokenCount: 4)
        let take = try XCTUnwrap(takes.first)
        XCTAssertEqual(take.signals.disfluencyCount, 2)
        XCTAssertEqual(take.kind, .scripted)
    }

    func testTakeTimeRangeSpansTheFirstAndLastWord() throws {
        let transcript = makeTranscript([("a", false), ("b", false), ("c", false)],
                                        wordDuration: 0.5, gap: 0.1)
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<3,
                                             transcriptWordRange: 0..<3)
        let take = try XCTUnwrap(TakeDetector.takes(spans: [span],
                                                    transcript: transcript,
                                                    scriptTokenCount: 3).first)
        XCTAssertEqual(take.timeRange.lowerBound, transcript.words[0].start, accuracy: 1e-9)
        XCTAssertEqual(take.timeRange.upperBound, transcript.words[2].end, accuracy: 1e-9)
    }

    func testRestartIsDetectedFromARepeatedBigram() throws {
        // "so the — so the thing is fine": the bigram "so the" repeats close by.
        let transcript = makeTranscript([
            ("so", false), ("the", false), ("so", false), ("the", false),
            ("thing", false), ("is", false), ("fine", false),
        ])
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<5,
                                             transcriptWordRange: 0..<7)
        let take = try XCTUnwrap(TakeDetector.takes(spans: [span],
                                                    transcript: transcript,
                                                    scriptTokenCount: 5).first)
        XCTAssertTrue(take.signals.restartDetected)
    }

    func testCleanReadHasNoRestart() throws {
        let transcript = makeTranscript([
            ("pricing", false), ("signals", false), ("value", false),
            ("to", false), ("buyers", false), ("everywhere", false),
        ])
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<6,
                                             transcriptWordRange: 0..<6)
        let take = try XCTUnwrap(TakeDetector.takes(spans: [span],
                                                    transcript: transcript,
                                                    scriptTokenCount: 6).first)
        XCTAssertFalse(take.signals.restartDetected)
        XCTAssertEqual(take.signals.disfluencyCount, 0)
    }

    func testCompletedFractionIsCappedAtOne() throws {
        // More spoken words than script tokens must not report >100% coverage.
        let transcript = makeTranscript((0..<10).map { ("w\($0)", false) })
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<3,
                                             transcriptWordRange: 0..<10)
        let take = try XCTUnwrap(TakeDetector.takes(spans: [span],
                                                    transcript: transcript,
                                                    scriptTokenCount: 3).first)
        XCTAssertLessThanOrEqual(take.signals.completedFraction, 1.0)
        XCTAssertGreaterThan(take.signals.completedFraction, 0)
    }

    func testWordsPerMinuteIsPlausible() throws {
        // 10 words in 6 seconds ≈ 100 wpm (word starts 0.0, 0.6, …).
        let transcript = makeTranscript((0..<10).map { ("w\($0)", false) },
                                        wordDuration: 0.5, gap: 0.1)
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<10,
                                             transcriptWordRange: 0..<10)
        let take = try XCTUnwrap(TakeDetector.takes(spans: [span],
                                                    transcript: transcript,
                                                    scriptTokenCount: 10).first)
        XCTAssertGreaterThan(take.signals.wordsPerMinute, 50)
        XCTAssertLessThan(take.signals.wordsPerMinute, 250)
    }

    func testOutOfBoundsSpanIsClampedRatherThanCrashing() {
        // A malformed span must not index past the transcript.
        let transcript = makeTranscript([("a", false), ("b", false)])
        let span = ScriptAligner.AlignedSpan(scriptTokenRange: 0..<2,
                                             transcriptWordRange: 0..<99)
        let takes = TakeDetector.takes(spans: [span],
                                       transcript: transcript,
                                       scriptTokenCount: 2)
        XCTAssertEqual(takes.count, 1)
        XCTAssertLessThanOrEqual(takes[0].timeRange.upperBound,
                                 transcript.words.last?.end ?? 0)
    }

    func testNoSpansYieldsNoTakes() {
        let transcript = makeTranscript([("a", false)])
        XCTAssertTrue(TakeDetector.takes(spans: [],
                                         transcript: transcript,
                                         scriptTokenCount: 1).isEmpty)
    }

    // MARK: Transcript mapping

    func testWordIndexAtTimeFindsTheSpokenWord() throws {
        let transcript = makeTranscript((0..<5).map { ("w\($0)", false) },
                                        wordDuration: 0.5, gap: 0.5)
        // Word 2 runs 2.0…2.5 with this spacing.
        let index = try XCTUnwrap(transcript.wordIndex(at: 2.1))
        XCTAssertEqual(index, 2)
    }

    func testTimeRangeOfWordRange() throws {
        let transcript = makeTranscript((0..<5).map { ("w\($0)", false) },
                                        wordDuration: 0.5, gap: 0.5)
        let range = try XCTUnwrap(transcript.timeRange(of: 1..<3))
        XCTAssertEqual(range.lowerBound, transcript.words[1].start, accuracy: 1e-9)
        XCTAssertEqual(range.upperBound, transcript.words[2].end, accuracy: 1e-9)
    }

    func testEnabledWordsSkipCutMaterialAndCarryTimelinePositions() {
        let transcript = makeTranscript((0..<10).map { ("w\($0)", false) },
                                        wordDuration: 0.5, gap: 0.5)
        var edl = EditDecisionList.initial(sourceDuration: 10)
        // Cut the window covering words 2–4 (source 2.0…4.5).
        edl.deleteRange(2.0...4.5)

        let enabled = transcript.enabledWords(edl: edl)
        XCTAssertLessThan(enabled.count, transcript.words.count,
                          "cut words must not appear in the caption stream")
        XCTAssertFalse(enabled.contains { $0.index == 3 },
                       "word 3 was inside the cut")
        // Timeline positions are non-decreasing.
        let starts = enabled.map(\.timelineStart)
        XCTAssertEqual(starts, starts.sorted())
    }

    // MARK: Helpers

    /// Words laid end to end: each `wordDuration` long, separated by `gap`.
    private func makeTranscript(_ words: [(String, Bool)],
                                wordDuration: Double = 0.3,
                                gap: Double = 0.1) -> Transcript {
        var out: [Word] = []
        var t = 0.0
        for (text, isDisfluency) in words {
            out.append(Word(text: text,
                            start: t,
                            end: t + wordDuration,
                            confidence: 0.95,
                            trackId: "track-1",
                            isDisfluency: isDisfluency))
            t += wordDuration + gap
        }
        return Transcript(words: out)
    }
}
