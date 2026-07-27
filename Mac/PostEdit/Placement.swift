import Foundation
import AVFoundation

/// One instruction for laying a source's media onto a composition track.
///
/// Extracted out of `CompositionBuilder.build` so the arithmetic can be tested
/// without AVFoundation — this codebase has never been compiled, and an
/// off-by-one in placement shows up as drift rather than as a crash.
enum Placement: Equatable {
    /// Insert this source range at this composition time.
    case insert(source: ClosedRange<Double>, at: Double)
    /// Leave this composition range empty, so every track stays the same
    /// length regardless of how much media each file actually has.
    case empty(ClosedRange<Double>)
}

enum MediaPlacement {
    /// Where each segment's media goes on one composition track.
    ///
    /// - `sourceOffset`: session-source seconds at which this file's own t=0
    ///   sits. Zero for participant recordings, which all start together;
    ///   non-zero for an external file that started rolling later or earlier.
    /// - `assetDuration`: how much media the file actually has, so a short file
    ///   pads rather than throwing.
    /// - `timelineOffset`: shifts everything later in the composition, which is
    ///   how an intro bookend makes room for itself.
    ///
    /// Head padding falls out of the same arithmetic as tail padding: if the
    /// session started before this file did, the first part of the segment has
    /// no media to show.
    static func placements(segments: [(clip: Clip, timelineStart: Double)],
                           sourceOffset: Double = 0,
                           assetDuration: Double,
                           timelineOffset: Double = 0) -> [Placement] {
        var result: [Placement] = []

        for (clip, timelineStart) in segments {
            let at = timelineStart + timelineOffset
            let segmentEnd = at + clip.duration

            // Segment bounds expressed in this file's own timeline.
            let wantedStart = clip.sourceRange.lowerBound - sourceOffset
            let wantedEnd = clip.sourceRange.upperBound - sourceOffset

            let availableStart = max(0, wantedStart)
            let availableEnd = min(wantedEnd, assetDuration)

            // Head: the file hadn't started yet.
            if availableStart > wantedStart {
                let lead = min(availableStart - wantedStart, clip.duration)
                result.append(.empty(at...(at + lead)))
            }
            let insertAt = at + max(0, availableStart - wantedStart)

            if availableStart < availableEnd {
                result.append(.insert(source: availableStart...availableEnd, at: insertAt))
            }

            // Tail: the file ran out before the segment did.
            let consumed = max(0, availableEnd - availableStart)
            let tailStart = insertAt + consumed
            if tailStart < segmentEnd {
                result.append(.empty(tailStart...segmentEnd))
            }
        }
        return result
    }

    /// Applies placements to a composition track. The AVFoundation half, kept
    /// separate from the arithmetic above so only this part needs a Mac.
    static func apply(_ placements: [Placement],
                      of sourceTrack: AVAssetTrack,
                      to compTrack: AVMutableCompositionTrack,
                      timescale: CMTimeScale) throws {
        for placement in placements {
            switch placement {
            case .insert(let source, let at):
                let range = CMTimeRange(
                    start: CMTime(seconds: source.lowerBound, preferredTimescale: timescale),
                    end: CMTime(seconds: source.upperBound, preferredTimescale: timescale))
                try compTrack.insertTimeRange(range, of: sourceTrack,
                                              at: CMTime(seconds: at, preferredTimescale: timescale))
            case .empty(let range):
                guard range.upperBound > range.lowerBound else { continue }
                compTrack.insertEmptyTimeRange(CMTimeRange(
                    start: CMTime(seconds: range.lowerBound, preferredTimescale: timescale),
                    end: CMTime(seconds: range.upperBound, preferredTimescale: timescale)))
            }
        }
    }
}
