import Foundation

/// How a timer's total time is divided into announced intervals — the primary
/// way cues are defined in the creation flow:
///
/// - `.even(count:)`     — split the total into N equal intervals.
/// - `.spacing(seconds:)`— announce every X seconds.
/// - `.custom(lengths:)` — set each interval's length individually.
/// - `.workRest(works:rest:)` — run a list of work segments, then a rest, and
///                         repeat (e.g. 4 exercises then a break) until the total
///                         runs out.
struct IntervalPlan: Codable, Hashable {

    enum Spec: Hashable {
        case even(count: Int)
        case spacing(seconds: TimeInterval)
        case custom(lengths: [TimeInterval])
        case workRest(works: [TimeInterval], rest: TimeInterval)
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
    /// When true (and the countdown is enabled), count down the *whole* interval
    /// out loud rather than just the last N seconds.
    var countdownWhole: Bool? = nil
    /// Optional spoken name per interval, in order ("Push-ups", "Squats", …).
    /// When set for a segment, it replaces the "Interval N" announcement. Applies
    /// to even / every / custom plans (work/rest keeps its Exercise/Round labels).
    /// Optional for backward-compatible decoding.
    var stepNames: [String]? = nil

    /// The trimmed name for segment `index` (0-based), or nil if none/blank.
    func stepName(forSegment index: Int) -> String? {
        guard let names = stepNames, index >= 0, index < names.count else { return nil }
        let n = names[index].trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? nil : n
    }
    /// Whether any step names are set (drives the editor toggle + start cue).
    var namesEnabled: Bool { stepNames?.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? false }

    /// Resolved last-N window (0 = off).
    var countdownSeconds: Int { countdown ?? 0 }
    /// Whether to narrate the entire interval.
    var countsWholeInterval: Bool { countdownWhole ?? false }
    /// Whether any per-interval countdown is active.
    var countdownEnabled: Bool { countsWholeInterval || countdownSeconds > 0 }

    /// A resolved cue point: when it fires, what to say, what to display, and the
    /// haptic to use (work and rest boundaries feel different in work/rest mode).
    struct Boundary: Hashable {
        let time: TimeInterval
        let label: String
        let spokenText: String
        let haptic: HapticPattern
    }

    /// The interval boundary offsets within `duration`, in increasing order.
    /// Internal boundaries only — the final boundary coincides with completion
    /// (handled separately by the engine), so it's excluded.
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
            while t < duration - 0.001 {
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
        case .workRest:
            return workRestCuePoints(forDuration: duration).map(\.time)
        }
    }

    /// Resolved, labelled cue points used to build the engine's cues.
    func cuePoints(forDuration duration: TimeInterval) -> [Boundary] {
        switch spec {
        case .workRest:
            return workRestCuePoints(forDuration: duration)
        default:
            return boundaries(forDuration: duration).enumerated().map { i, t in
                // Boundary i is entering segment i+1 (0-based). Prefer its custom
                // name; otherwise the numbered fallback.
                if let name = stepName(forSegment: i + 1) {
                    return Boundary(time: t, label: name, spokenText: name, haptic: haptic)
                }
                let n = i + 1
                return Boundary(time: t, label: "Interval \(n)",
                                spokenText: announceNumber ? "Interval \(n)" : "",
                                haptic: haptic)
            }
        }
    }

    /// The repeating [work…, rest] sequence, labelled: work→work boundaries say
    /// "Exercise k" / "Next", the last work→rest says "Rest", and rest→next round
    /// says "Round n" / "Go".
    private func workRestCuePoints(forDuration duration: TimeInterval) -> [Boundary] {
        guard case .workRest(let rawWorks, let rest) = spec else { return [] }
        let works = rawWorks.filter { $0 > 0 }
        guard !works.isEmpty, rest > 0, duration > 0 else { return [] }
        let sequence = works + [rest]          // one round
        let restPos = works.count              // index of the rest within a round
        var result: [Boundary] = []
        var t: TimeInterval = 0
        var idx = 0
        var round = 1
        while true {
            let pos = idx % sequence.count
            t += sequence[pos]
            if t >= duration - 0.001 { break }
            let boundary: Boundary
            if pos == restPos {
                // rest just ended → next round (work) begins
                round += 1
                let s = announceNumber ? "Round \(round)" : "Go"
                boundary = Boundary(time: t, label: s, spokenText: s, haptic: haptic)
            } else if pos == restPos - 1 {
                // last work ended → rest begins
                boundary = Boundary(time: t, label: "Rest", spokenText: "Rest",
                                    haptic: .directionDown)
            } else {
                // a work ended, another work begins in the same round
                let ex = pos + 2
                let s = announceNumber ? "Exercise \(ex)" : "Next"
                boundary = Boundary(time: t, label: s, spokenText: s, haptic: haptic)
            }
            result.append(boundary)
            idx += 1
        }
        return result
    }

    /// How many intervals/segments the plan describes over `duration`.
    func intervalCount(forDuration duration: TimeInterval) -> Int {
        boundaries(forDuration: duration).count + 1
    }
}

// MARK: - Spec Codable (matches the synthesized layout, migrates legacy work/rest)

extension IntervalPlan.Spec: Codable {
    private enum CaseKey: String, CodingKey { case even, spacing, custom, workRest }
    private enum EvenKeys: String, CodingKey { case count }
    private enum SpacingKeys: String, CodingKey { case seconds }
    private enum CustomKeys: String, CodingKey { case lengths }
    private enum WorkRestKeys: String, CodingKey { case work, works, rest }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CaseKey.self)
        if c.contains(.even) {
            let n = try c.nestedContainer(keyedBy: EvenKeys.self, forKey: .even)
            self = .even(count: try n.decode(Int.self, forKey: .count))
        } else if c.contains(.spacing) {
            let n = try c.nestedContainer(keyedBy: SpacingKeys.self, forKey: .spacing)
            self = .spacing(seconds: try n.decode(TimeInterval.self, forKey: .seconds))
        } else if c.contains(.custom) {
            let n = try c.nestedContainer(keyedBy: CustomKeys.self, forKey: .custom)
            self = .custom(lengths: try n.decode([TimeInterval].self, forKey: .lengths))
        } else if c.contains(.workRest) {
            let n = try c.nestedContainer(keyedBy: WorkRestKeys.self, forKey: .workRest)
            let rest = try n.decode(TimeInterval.self, forKey: .rest)
            if let works = try? n.decode([TimeInterval].self, forKey: .works) {
                self = .workRest(works: works, rest: rest)
            } else {
                // Legacy single-work shape → wrap into a one-element list.
                let work = try n.decode(TimeInterval.self, forKey: .work)
                self = .workRest(works: [work], rest: rest)
            }
        } else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unknown IntervalPlan.Spec"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CaseKey.self)
        switch self {
        case .even(let count):
            var n = c.nestedContainer(keyedBy: EvenKeys.self, forKey: .even)
            try n.encode(count, forKey: .count)
        case .spacing(let seconds):
            var n = c.nestedContainer(keyedBy: SpacingKeys.self, forKey: .spacing)
            try n.encode(seconds, forKey: .seconds)
        case .custom(let lengths):
            var n = c.nestedContainer(keyedBy: CustomKeys.self, forKey: .custom)
            try n.encode(lengths, forKey: .lengths)
        case .workRest(let works, let rest):
            var n = c.nestedContainer(keyedBy: WorkRestKeys.self, forKey: .workRest)
            try n.encode(works, forKey: .works)
            try n.encode(rest, forKey: .rest)
        }
    }
}
