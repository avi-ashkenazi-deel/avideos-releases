import Foundation

/// How a timer's total time is divided into announced intervals — the primary
/// way cues are defined in the creation flow. Four ways to express it:
///
/// - `.even(count:)`     — split the total into N equal intervals (cue at each
///                         internal boundary).
/// - `.spacing(seconds:)`— announce every X seconds (count derived from total).
/// - `.custom(lengths:)` — set each interval's length individually, one by one.
/// - `.workRest(work:rest:)` — alternate a work segment and a rest segment
///                         (e.g. 1:00 on / 0:20 off) repeating until the total
///                         runs out, for sets with breaks between them.
struct IntervalPlan: Codable, Hashable {

    enum Spec: Codable, Hashable {
        case even(count: Int)
        case spacing(seconds: TimeInterval)
        case custom(lengths: [TimeInterval])
        case workRest(work: TimeInterval, rest: TimeInterval)
    }

    var spec: Spec
    /// Default alert style applied to every interval boundary.
    var alert: AlertStyle = .voiceAndHaptic
    /// Haptic pattern for interval boundaries (work boundaries in work/rest).
    var haptic: HapticPattern = .notification
    /// Speak the interval/round number ("Interval 2" / "Round 2") rather than a
    /// bare cue.
    var announceNumber: Bool = true
    /// Count down the last N seconds before *each* interval boundary (e.g. 5 →
    /// "5,4,3,2,1" into the next interval). Optional for backward-compatible
    /// decoding; nil/0 = off.
    var countdown: Int? = nil

    /// Resolved countdown window (0 = off).
    var countdownSeconds: Int { countdown ?? 0 }

    /// A resolved cue point: when it fires, what to say, what to display, and the
    /// haptic to use (work and rest boundaries feel different in work/rest mode).
    struct Boundary: Hashable {
        let time: TimeInterval
        let label: String
        let spokenText: String
        let haptic: HapticPattern
    }

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
        case .workRest(let work, let rest):
            guard work > 0, rest > 0 else { return [] }
            var result: [TimeInterval] = []
            var t: TimeInterval = 0
            var onWork = true
            while true {
                t += onWork ? work : rest
                if t >= duration - 0.001 { break }
                result.append(t)
                onWork.toggle()
            }
            return result
        }
    }

    /// Resolved, labelled cue points used to build the engine's cues. Carries the
    /// spoken text, display label and haptic for each boundary.
    func cuePoints(forDuration duration: TimeInterval) -> [Boundary] {
        let times = boundaries(forDuration: duration)
        switch spec {
        case .workRest:
            // Even index = a work segment just ended → rest begins.
            // Odd index  = a rest segment ended → the next work round begins.
            return times.enumerated().map { i, t in
                if i % 2 == 0 {
                    return Boundary(time: t, label: "Rest", spokenText: "Rest",
                                    haptic: .directionDown)
                } else {
                    let round = i / 2 + 2
                    let go = announceNumber ? "Round \(round)" : "Go"
                    return Boundary(time: t, label: go, spokenText: go, haptic: haptic)
                }
            }
        default:
            return times.enumerated().map { i, t in
                let n = i + 1
                return Boundary(time: t, label: "Interval \(n)",
                                spokenText: announceNumber ? "Interval \(n)" : "",
                                haptic: haptic)
            }
        }
    }

    /// How many intervals/segments the plan describes over `duration` (for the
    /// count UI / summary).
    func intervalCount(forDuration duration: TimeInterval) -> Int {
        boundaries(forDuration: duration).count + 1
    }
}
