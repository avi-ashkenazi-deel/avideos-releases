import Foundation

/// Word-level transcript on the common *source* timeline. Speaker identity is
/// the track (single-speaker per-track transcription), so `trackId` doubles
/// as the speaker key.
struct Word: Codable, Sendable, Equatable, Identifiable {
    /// Stable identity: position in `Transcript.words` never changes after
    /// merge, so the array index is the canonical word index used by the
    /// aligner, the AI passes and the editor. `id` exists for SwiftUI.
    var id: UUID
    var text: String
    /// Seconds, source timeline.
    var start: Double
    var end: Double
    /// 0...1 recognizer confidence.
    var confidence: Double
    /// The `EditTrack.id` this word was recognized on (== speaker).
    var trackId: String
    var isDisfluency: Bool

    init(id: UUID = UUID(),
         text: String,
         start: Double,
         end: Double,
         confidence: Double,
         trackId: String,
         isDisfluency: Bool = false) {
        self.id = id
        self.text = text
        self.start = start
        self.end = end
        self.confidence = confidence
        self.trackId = trackId
        self.isDisfluency = isDisfluency
    }

    var timeRange: ClosedRange<Double> { min(start, end)...max(start, end) }
    var duration: Double { max(0, end - start) }
}

struct Transcript: Codable, Sendable, Equatable {
    /// Sorted by `start` (merge order across tracks).
    var words: [Word]
    /// BCP-47 language tag, e.g. "en".
    var language: String

    init(words: [Word], language: String = "en") {
        self.words = words.sorted { $0.start < $1.start }
        self.language = language
    }

    // MARK: Text reconstruction

    /// Plain-text reconstruction of a word range (source order).
    func text(in range: Range<Int>) -> String {
        guard !words.isEmpty else { return "" }
        let clamped = max(0, range.lowerBound)..<min(words.count, range.upperBound)
        guard clamped.lowerBound < clamped.upperBound else { return "" }
        return words[clamped].map(\.text).joined(separator: " ")
    }

    var fullText: String { text(in: 0..<words.count) }

    // MARK: Index / time lookup

    /// Index of the word playing at (or the first word starting after) the
    /// given source time. Binary search over `start`.
    func wordIndex(at sourceTime: Double) -> Int? {
        guard !words.isEmpty else { return nil }
        var lo = 0, hi = words.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if words[mid].start <= sourceTime { lo = mid } else { hi = mid - 1 }
        }
        if words[lo].start > sourceTime {
            return sourceTime <= words[0].timeRange.upperBound ? 0 : nil
        }
        if words[lo].timeRange.contains(sourceTime) { return lo }
        // Between words: report the word we're between-after, so the caret
        // follows playback naturally.
        return lo
    }

    /// The contiguous word-index range whose midpoints fall inside a source
    /// time range. Used to map an EDL clip back to transcript words.
    func wordRange(intersecting sourceRange: ClosedRange<Double>) -> Range<Int> {
        var first: Int?
        var lastExclusive = 0
        for (i, w) in words.enumerated() {
            let mid = (w.start + w.end) / 2
            if sourceRange.contains(mid) {
                if first == nil { first = i }
                lastExclusive = i + 1
            } else if first != nil, mid > sourceRange.upperBound {
                break
            }
        }
        guard let f = first else { return 0..<0 }
        return f..<lastExclusive
    }

    /// Source time range covered by a word-index range (nil for empty).
    func timeRange(of range: Range<Int>) -> ClosedRange<Double>? {
        let clamped = max(0, range.lowerBound)..<min(words.count, range.upperBound)
        guard clamped.lowerBound < clamped.upperBound else { return nil }
        let start = words[clamped.lowerBound].start
        let end = words[clamped.upperBound - 1].end
        return min(start, end)...max(start, end)
    }

    // MARK: Edit-aware views

    /// Words whose midpoint lies in an enabled clip, together with their
    /// *edited-timeline* start time. This is the input for chapter generation
    /// and caption rendering on the edited program.
    func enabledWords(edl: EditDecisionList) -> [(index: Int, word: Word, timelineStart: Double)] {
        var out: [(Int, Word, Double)] = []
        for (i, w) in words.enumerated() {
            let mid = (w.start + w.end) / 2
            if let t = edl.mapSourceToTimeline(mid) {
                // Shift so the returned time is the word *start* on the timeline.
                out.append((i, w, max(0, t - (mid - w.start))))
            }
        }
        return out
    }
}
