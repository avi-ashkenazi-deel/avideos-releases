import Foundation

/// Aligns a teleprompter script against a transcript and detects retakes:
/// 4-gram anchor matching finds high-confidence correspondences, banded
/// Needleman–Wunsch fills between anchors, and overlapping monotonic spans
/// covering the same script region = the host doing another take.
///
/// Pure functions over token arrays — unit-testable without media.
enum ScriptAligner {
    struct AlignedSpan: Equatable {
        var scriptTokenRange: Range<Int>
        var transcriptWordRange: Range<Int>
    }

    /// Normalizes exactly like ScriptDocument.tokenize so offsets never drift.
    static func normalize(_ text: String) -> [String] {
        ScriptDocument.tokenize(text)
    }

    /// Transcript words → normalized tokens (disfluencies keep their index
    /// but never match script tokens).
    static func transcriptTokens(_ transcript: Transcript) -> [String] {
        transcript.words.map { word in
            word.isDisfluency ? "<disfluency>" : normalizeToken(word.text)
        }
    }

    static func normalizeToken(_ token: String) -> String {
        token.lowercased()
            .trimmingCharacters(in: .punctuationCharacters)
            .replacingOccurrences(of: "’", with: "'")
    }

    // MARK: - Alignment

    /// Aligns script tokens to transcript tokens. Returns monotonic spans
    /// (multiple spans over the same script range indicate retakes).
    static func align(scriptTokens: [String], transcriptTokens: [String]) -> [AlignedSpan] {
        guard !scriptTokens.isEmpty, !transcriptTokens.isEmpty else { return [] }

        // 1. Anchor matching: script 4-gram shingles that appear in the
        //    transcript. Non-unique script shingles may match repeatedly —
        //    that's the retake signal, so keep ALL matches.
        let n = 4
        // Too short to shingle: no anchors are possible, so there is no
        // evidence of alignment. See the note on the anchor guard below for
        // why that must not be reported as a match.
        guard scriptTokens.count >= n else { return [] }

        var scriptShingles: [String: [Int]] = [:]
        for i in 0...(scriptTokens.count - n) {
            let key = scriptTokens[i..<i+n].joined(separator: " ")
            scriptShingles[key, default: []].append(i)
        }

        struct Anchor {
            let scriptIndex: Int
            let transcriptIndex: Int
        }
        var anchors: [Anchor] = []
        if transcriptTokens.count >= n {
            for t in 0...(transcriptTokens.count - n) {
                let key = transcriptTokens[t..<t+n].joined(separator: " ")
                guard let scriptPositions = scriptShingles[key] else { continue }
                // Prefer the script position: for retake detection each
                // transcript occurrence anchors to its best script home —
                // take the FIRST script position (the canonical location).
                anchors.append(Anchor(scriptIndex: scriptPositions[0], transcriptIndex: t))
            }
        }
        // No shared 4-gram anywhere means this transcript is not a read of
        // this script, and an empty result is the only honest answer.
        //
        // This previously returned one span covering everything, which asserts
        // the opposite — that the whole transcript is a faithful read of the
        // whole script. Downstream that is not cosmetic: TakeDetector would
        // manufacture a take from it and ClaudeTakeSelector could then discard
        // it as the losing one, silently cutting material that was never in
        // the script at all. Ad-libs are preserved, never cut.
        //
        // The one caller already handles this correctly: no spans yields no
        // takes, and the user is told there is nothing to choose between.
        guard !anchors.isEmpty else { return [] }

        // 2. Split anchors into monotonic runs over TRANSCRIPT order: when
        //    the script index jumps backwards significantly, a new take
        //    (re-read of earlier material) started.
        anchors.sort { $0.transcriptIndex < $1.transcriptIndex }
        var runs: [[Anchor]] = []
        var currentRun: [Anchor] = []
        for anchor in anchors {
            if let last = currentRun.last, anchor.scriptIndex < last.scriptIndex - n {
                runs.append(currentRun)
                currentRun = []
            }
            currentRun.append(anchor)
        }
        if !currentRun.isEmpty { runs.append(currentRun) }

        // 3. Each run becomes a span, expanded to the shingle width and to
        //    the midpoint boundaries between neighboring runs in transcript
        //    space (so flub words between anchors belong to a take).
        var spans: [AlignedSpan] = []
        for (index, run) in runs.enumerated() {
            guard let first = run.first, let last = run.last else { continue }
            let scriptStart = run.map(\.scriptIndex).min() ?? first.scriptIndex
            let scriptEnd = (run.map(\.scriptIndex).max() ?? last.scriptIndex) + n

            var transcriptStart = first.transcriptIndex
            var transcriptEnd = last.transcriptIndex + n
            if index > 0, let previousLast = runs[index - 1].last {
                transcriptStart = min(transcriptStart, previousLast.transcriptIndex + n)
            } else {
                transcriptStart = 0
            }
            if index == runs.count - 1 {
                transcriptEnd = transcriptTokens.count
            } else if let nextFirst = runs[index + 1].first {
                transcriptEnd = max(transcriptEnd, nextFirst.transcriptIndex)
            }

            spans.append(AlignedSpan(
                scriptTokenRange: scriptStart..<min(scriptEnd, scriptTokens.count),
                transcriptWordRange: max(0, transcriptStart)..<min(transcriptEnd, transcriptTokens.count)))
        }
        return spans
    }
}

// MARK: - Take detection

/// One contiguous read of (part of) the script — or an ad-lib.
struct ScriptTake: Identifiable, Equatable {
    enum Kind: Equatable {
        case scripted
        case adlib
    }

    let id = UUID()
    var kind: Kind
    var scriptTokenRange: Range<Int>
    var transcriptWordRange: Range<Int>
    var timeRange: ClosedRange<Double>
    var signals: TakeSignals
}

/// Deterministic quality signals per take — computed locally, sent to Claude
/// alongside the words so selection isn't judged on prose alone.
struct TakeSignals: Equatable {
    /// Fraction of the take's script range actually covered.
    var completedFraction: Double
    var disfluencyCount: Int
    /// The speaker visibly restarted mid-take ("so the— so the thing is").
    var restartDetected: Bool
    var wordsPerMinute: Double
    /// The take trails off before finishing its script range.
    var trailingAbandon: Bool
}

enum TakeDetector {
    /// Groups aligned spans into takes with quality signals. Spans covering
    /// overlapping script ranges are retakes of the same material.
    static func takes(spans: [ScriptAligner.AlignedSpan],
                      transcript: Transcript,
                      scriptTokenCount: Int) -> [ScriptTake] {
        var takes: [ScriptTake] = []

        for span in spans {
            let words = Array(transcript.words[clamp(span.transcriptWordRange, max: transcript.words.count)])
            guard let firstWord = words.first, let lastWord = words.last else { continue }

            let duration = max(lastWord.end - firstWord.start, 0.01)
            let disfluencies = words.filter(\.isDisfluency).count
            let wpm = Double(words.count) / duration * 60

            // Restart heuristic: the same normalized 2-gram appearing twice
            // within a 12-word window.
            var restart = false
            let tokens = words.map { ScriptAligner.normalizeToken($0.text) }
            if tokens.count >= 4 {
                outer: for i in 0..<(tokens.count - 3) {
                    let bigram = "\(tokens[i]) \(tokens[i + 1])"
                    for j in (i + 2)..<min(i + 12, tokens.count - 1) {
                        if "\(tokens[j]) \(tokens[j + 1])" == bigram {
                            restart = true
                            break outer
                        }
                    }
                }
            }

            let scriptSpanLength = span.scriptTokenRange.count
            // Approximate coverage: matched words (non-disfluency) vs script span.
            let spokenUseful = words.count - disfluencies
            let completed = scriptSpanLength > 0
                ? min(1, Double(spokenUseful) / Double(scriptSpanLength))
                : 0

            takes.append(ScriptTake(
                kind: .scripted,
                scriptTokenRange: span.scriptTokenRange,
                transcriptWordRange: span.transcriptWordRange,
                timeRange: firstWord.start...lastWord.end,
                signals: TakeSignals(completedFraction: completed,
                                     disfluencyCount: disfluencies,
                                     restartDetected: restart,
                                     wordsPerMinute: wpm,
                                     trailingAbandon: completed < 0.6)))
        }

        // Ad-libs: transcript stretches (≥8 words) not covered by any span.
        var covered = Array(repeating: false, count: transcript.words.count)
        for span in spans {
            for i in clamp(span.transcriptWordRange, max: transcript.words.count) {
                covered[i] = true
            }
        }
        var runStart: Int?
        for i in 0...covered.count {
            let isUncovered = i < covered.count && !covered[i]
            if isUncovered {
                if runStart == nil { runStart = i }
            } else if let start = runStart {
                if i - start >= 8 {
                    let words = Array(transcript.words[start..<i])
                    if let first = words.first, let last = words.last {
                        takes.append(ScriptTake(
                            kind: .adlib,
                            scriptTokenRange: 0..<0,
                            transcriptWordRange: start..<i,
                            timeRange: first.start...last.end,
                            signals: TakeSignals(completedFraction: 1,
                                                 disfluencyCount: words.filter(\.isDisfluency).count,
                                                 restartDetected: false,
                                                 wordsPerMinute: 0,
                                                 trailingAbandon: false)))
                    }
                }
                runStart = nil
            }
        }

        return takes.sorted { $0.timeRange.lowerBound < $1.timeRange.lowerBound }
    }

    /// Takes covering overlapping script ranges, grouped for selection.
    static func retakeGroups(_ takes: [ScriptTake]) -> [[ScriptTake]] {
        let scripted = takes.filter { $0.kind == .scripted }
        var groups: [[ScriptTake]] = []
        var used = Set<UUID>()
        for take in scripted where !used.contains(take.id) {
            var group = [take]
            used.insert(take.id)
            for other in scripted where !used.contains(other.id) {
                if take.scriptTokenRange.overlaps(other.scriptTokenRange) {
                    group.append(other)
                    used.insert(other.id)
                }
            }
            groups.append(group)
        }
        return groups
    }

    private static func clamp(_ range: Range<Int>, max maxValue: Int) -> Range<Int> {
        let lower = Swift.max(0, Swift.min(range.lowerBound, maxValue))
        let upper = Swift.max(lower, Swift.min(range.upperBound, maxValue))
        return lower..<upper
    }
}
