import Foundation

/// Aligns one recorded track onto the common session timeline:
///  - offsetMs: where the track's media t=0 sits relative to the take start
///    (from the clock anchor);
///  - rateFactor: consumer-clock drift correction from a least-squares linear
///    fit over the sparse chunk timeline (mediaTime → sessionTime), clamped
///    to ppm scale — drift up to ~100ppm ≈ 360ms/hour is real and audible on
///    long episodes if ignored.
///
/// Pure math, unit-testable; a future waveform cross-correlator slots in
/// behind the same protocol.
protocol TrackAligning {
    func alignment(for track: TrackRecord, takeStartSessionMs: Double) -> TrackAlignment
}

struct TrackAlignment: Equatable {
    /// Positive = the track's media starts AFTER the take start (pad/delay);
    /// negative = it started early (trim the head).
    var offsetMs: Double
    /// Multiply media playback rate by this to land on the session clock
    /// (0.999…1.001 — ppm scale; exactly 1.0 when there's no fit data).
    var rateFactor: Double

    static let identity = TrackAlignment(offsetMs: 0, rateFactor: 1)
}

struct LinearDriftAligner: TrackAligning {
    /// Rate clamp: anything outside ±1000ppm is a data artifact, not drift.
    static let rateBounds = 0.999...1.001

    func alignment(for track: TrackRecord, takeStartSessionMs: Double) -> TrackAlignment {
        guard let anchor = track.anchor else { return .identity }

        let baseOffset = (anchor.sessionTimeMs - anchor.mediaTimeMs) - takeStartSessionMs

        // Need ≥3 stamps for a fit that beats the anchor alone.
        let stamps = track.chunkTimeline
        guard stamps.count >= 3 else {
            return TrackAlignment(offsetMs: baseOffset, rateFactor: 1)
        }

        // Least squares: sessionTime = a·mediaTime + b.
        let n = Double(stamps.count)
        let sumX = stamps.reduce(0.0) { $0 + $1.mediaTimeMs }
        let sumY = stamps.reduce(0.0) { $0 + $1.sessionTimeMs }
        let sumXY = stamps.reduce(0.0) { $0 + $1.mediaTimeMs * $1.sessionTimeMs }
        let sumXX = stamps.reduce(0.0) { $0 + $1.mediaTimeMs * $1.mediaTimeMs }

        let denominator = n * sumXX - sumX * sumX
        guard abs(denominator) > 1e-9 else {
            return TrackAlignment(offsetMs: baseOffset, rateFactor: 1)
        }

        let a = (n * sumXY - sumX * sumY) / denominator   // session ms per media ms
        let b = (sumY - a * sumX) / n                     // session ms at media t=0

        // `a` is how fast session time advances per media unit: if the
        // device clock runs FAST (media accumulates quicker than session
        // time), a < 1 and playback must slow by the same factor.
        let rate = Self.rateBounds.contains(a) ? a : 1.0
        let fittedOffset = b - takeStartSessionMs

        return TrackAlignment(offsetMs: fittedOffset, rateFactor: rate)
    }
}
