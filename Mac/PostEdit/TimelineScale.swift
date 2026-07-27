import Foundation
import CoreGraphics

/// Maps edited-timeline seconds to a vertical offset and back.
///
/// The timeline runs top → bottom so it can sit beside the transcript, and
/// the mapping is pluggable because the two useful answers to "how far down
/// is 30 seconds?" are genuinely different:
///
/// - `UniformTimeScale` — constant points per second. Everything is
///   proportional, waveforms mean what they look like, and trimming is
///   precise. Long silences push the transcript out of alignment.
/// - `TextAlignedScale` — a word sits exactly beside its own text, so the two
///   panes read as one document. Silences get explicit blocks sized by real
///   duration, so a four-second pause is still visible and grabbable.
///
/// Both are value types built from a snapshot, so the timeline never reaches
/// into the text view while drawing.
protocol TimelineScale: Sendable {
    /// Vertical offset in points for an edited-timeline second.
    func offset(forTime time: Double) -> CGFloat
    /// The inverse, for hit-testing a drag or a click.
    func time(forOffset offset: CGFloat) -> Double
    /// Total scrollable height.
    var contentHeight: CGFloat { get }
}

// MARK: - Uniform

/// Strict time: every second is the same height.
struct UniformTimeScale: TimelineScale {
    var pointsPerSecond: CGFloat
    var duration: Double

    /// Matches the horizontal timeline's old default zoom so the two feel
    /// related, and clamps to the same range.
    init(pointsPerSecond: CGFloat = 40, duration: Double) {
        self.pointsPerSecond = min(max(pointsPerSecond, 4), 400)
        self.duration = max(duration, 0)
    }

    func offset(forTime time: Double) -> CGFloat {
        CGFloat(max(0, time)) * pointsPerSecond
    }

    func time(forOffset offset: CGFloat) -> Double {
        guard pointsPerSecond > 0 else { return 0 }
        return max(0, min(Double(offset / pointsPerSecond), duration))
    }

    var contentHeight: CGFloat { offset(forTime: duration) }
}

// MARK: - Text aligned

/// One laid-out run of text, measured in the transcript view.
///
/// A run is whatever the transcript can report a rectangle for — in practice
/// one per word — carrying the edited-timeline span it covers.
struct TimelineTextRun: Sendable, Equatable {
    /// Edited-timeline seconds this run covers.
    var startTime: Double
    var endTime: Double
    /// Vertical extent of the text in the transcript's coordinate space.
    var minY: CGFloat
    var maxY: CGFloat

    var duration: Double { max(0, endTime - startTime) }
    var height: CGFloat { max(0, maxY - minY) }
}

/// Piecewise-linear scale built from the transcript's own layout, with gaps
/// between runs given height in proportion to how long they last.
///
/// The result is a hybrid on purpose: **text where there is speech, time where
/// there is silence.** Aligning to text alone would collapse a long pause to
/// nothing, and you would lose the ability to see or trim it — which is most
/// of why you look at a timeline during a podcast edit.
struct TextAlignedScale: TimelineScale {
    /// A monotonic sequence of (time, offset) knots. Interpolation between
    /// knots is linear, so the mapping is invertible everywhere.
    private let knots: [(time: Double, offset: CGFloat)]
    let contentHeight: CGFloat

    /// Height given to a second of silence between two runs of text.
    static let defaultPauseHeightPerSecond: CGFloat = 18
    /// Pauses shorter than this are absorbed into the text flow — the gap
    /// between two words in a sentence should not become a timeline block.
    static let minimumPauseDuration: Double = 0.35

    init(runs: [TimelineTextRun],
         duration: Double,
         pauseHeightPerSecond: CGFloat = TextAlignedScale.defaultPauseHeightPerSecond,
         fallbackPointsPerSecond: CGFloat = 40) {
        let ordered = runs
            .filter { $0.duration > 0 || $0.height > 0 }
            .sorted { $0.startTime < $1.startTime }

        guard let first = ordered.first else {
            // Nothing measured yet (no transcript, or the view hasn't laid out
            // once): behave exactly like the uniform scale so the timeline is
            // still usable rather than blank.
            let height = CGFloat(max(duration, 0)) * fallbackPointsPerSecond
            self.knots = [(0, 0), (max(duration, 0), height)]
            self.contentHeight = height
            return
        }

        // Anchored at the origin, then one gap-or-text step per run. The
        // lead-in before the first word is just the first gap — handling it
        // separately would count it twice.
        _ = first
        var built: [(time: Double, offset: CGFloat)] = [(0, 0)]
        var cursor: CGFloat = 0
        var previousEnd = 0.0

        for run in ordered {
            let gap = run.startTime - previousEnd
            if gap > Self.minimumPauseDuration {
                // A real pause: give it height for its duration.
                built.append((previousEnd, cursor))
                cursor += CGFloat(gap) * pauseHeightPerSecond
            }
            built.append((run.startTime, cursor))
            cursor += max(run.height, 1)
            built.append((run.endTime, cursor))
            previousEnd = run.endTime
        }

        // Tail after the last word.
        if duration > previousEnd {
            built.append((previousEnd, cursor))
            let tail = duration - previousEnd
            if tail > Self.minimumPauseDuration {
                cursor += CGFloat(tail) * pauseHeightPerSecond
            }
            built.append((duration, cursor))
        }

        self.knots = Self.madeMonotonic(built)
        self.contentHeight = cursor
    }

    /// Interpolation needs strictly increasing time; measured runs can share
    /// or overlap edges after rounding, and a non-monotonic knot list would
    /// make `time(forOffset:)` ambiguous.
    private static func madeMonotonic(
        _ input: [(time: Double, offset: CGFloat)]
    ) -> [(time: Double, offset: CGFloat)] {
        var out: [(time: Double, offset: CGFloat)] = []
        for knot in input {
            if let last = out.last {
                guard knot.time > last.time + 1e-9 else {
                    // Same instant, more height: keep the taller offset so the
                    // run still occupies its space.
                    if knot.offset > last.offset { out[out.count - 1].offset = knot.offset }
                    continue
                }
                guard knot.offset >= last.offset else { continue }
            }
            out.append(knot)
        }
        if out.isEmpty { out = [(0, 0)] }
        return out
    }

    // MARK: Interpolation
    //
    // Both directions are a binary search over `knots` plus a linear blend.
    // Written out twice rather than shared through key paths: this runs for
    // every drawn element on every frame, and the generic version allocated.

    func offset(forTime time: Double) -> CGFloat {
        guard let first = knots.first, let last = knots.last else { return 0 }
        if time <= first.time { return first.offset }
        if time >= last.time { return last.offset }

        var low = 0
        var high = knots.count - 1
        while high - low > 1 {
            let mid = (low + high) / 2
            if knots[mid].time <= time { low = mid } else { high = mid }
        }
        let a = knots[low], b = knots[high]
        let span = b.time - a.time
        guard span > 1e-12 else { return a.offset }
        return a.offset + (b.offset - a.offset) * CGFloat((time - a.time) / span)
    }

    func time(forOffset offset: CGFloat) -> Double {
        guard let first = knots.first, let last = knots.last else { return 0 }
        if offset <= first.offset { return first.time }
        if offset >= last.offset { return last.time }

        var low = 0
        var high = knots.count - 1
        while high - low > 1 {
            let mid = (low + high) / 2
            if knots[mid].offset <= offset { low = mid } else { high = mid }
        }
        let a = knots[low], b = knots[high]
        let span = b.offset - a.offset
        guard span > 1e-12 else { return a.time }
        return a.time + (b.time - a.time) * Double((offset - a.offset) / span)
    }
}
