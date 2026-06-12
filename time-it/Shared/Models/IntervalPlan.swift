import Foundation

/// How a timer's total time is divided into announced intervals — the primary
/// way cues are defined in the creation flow. Three equivalent-but-different
/// ways to express the same idea:
///
/// - `.even(count:)`     — split the total into N equal intervals (cue at each
///                         internal boundary).
/// - `.spacing(seconds:)`— announce every X seconds (count derived from total).
/// - `.custom(lengths:)` — set each interval's length individually, one by one.
struct IntervalPlan: Codable, Hashable {

    enum Spec: Codable, Hashable {
        case even(count: Int)
        case spacing(seconds: TimeInterval)
        case custom(lengths: [TimeInterval])
    }

    var spec: Spec
    /// Default alert style applied to every interval boundary.
    var alert: AlertStyle = .voiceAndHaptic
    /// Haptic pattern for interval boundaries.
    var haptic: HapticPattern = .notification
    /// Speak the interval number ("Interval 2") rather than just buzzing.
    var announceNumber: Bool = true

    /// The interval boundary offsets within `duration`, in increasing order.
    /// These are the *internal* boundaries only — the final boundary coincides
    /// with completion (handled separately by the engine), so it's excluded.
    func boundaries(forDuration duration: TimeInterval) -> [TimeInterval] {
        guard duration > 0 else { return [] }
        switch spec {
        case .even(let count):
            guard count > 1 else { return [] }
            let step = duration / Double(count)
            return (1..<count).map { Double($0) * step }
        case .spacing(let seconds):
            guard seconds > 0 else { return [] }
            var result: [TimeInterval] = []
            var t = seconds
            while t < duration - 0.001 {  // drop a boundary sitting on the end
                result.append(t)
                t += seconds
            }
            return result
        case .custom(let lengths):
            var result: [TimeInterval] = []
            var acc: TimeInterval = 0
            for len in lengths {
                acc += len
                if acc < duration - 0.001 { result.append(acc) }
            }
            return result
        }
    }

    /// How many intervals the plan describes over `duration` (for the count UI).
    func intervalCount(forDuration duration: TimeInterval) -> Int {
        boundaries(forDuration: duration).count + 1
    }
}
