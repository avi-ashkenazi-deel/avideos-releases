import Foundation

/// How a milestone's firing point is defined within a timer's total duration.
///
/// All three cases resolve to a single absolute "elapsed offset from start" via
/// `fireTime(forDuration:)`, so `TimerEngine` can treat every milestone the same
/// way regardless of how the user chose to express it.
enum MilestoneTrigger: Codable, Hashable {
    /// Fire when this fraction of the total time has elapsed (0.0...1.0).
    /// e.g. `.percentElapsed(0.5)` → halftime.
    case percentElapsed(Double)

    /// Fire when this fraction of the total time remains (0.0...1.0).
    /// e.g. `.percentRemaining(0.3)` → when 30% is left.
    case percentRemaining(Double)

    /// Fire when this many seconds remain.
    /// e.g. `.secondsRemaining(30)` → the classic "30 seconds left" warning.
    case secondsRemaining(TimeInterval)

    /// The elapsed-time offset (seconds from start) at which this milestone fires.
    func fireTime(forDuration duration: TimeInterval) -> TimeInterval {
        switch self {
        case .percentElapsed(let f):
            return duration * clampFraction(f)
        case .percentRemaining(let f):
            return duration * (1 - clampFraction(f))
        case .secondsRemaining(let s):
            // Clamp into the timer's window so a "60s left" marker on a 45s timer
            // doesn't sit in the past (which would fire immediately on start).
            return max(0, duration - max(0, s))
        }
    }

    private func clampFraction(_ f: Double) -> Double { min(max(f, 0), 1) }
}

/// A single point in a timer at which we alert the user.
struct TimerMilestone: Codable, Hashable, Identifiable {
    var id: UUID = UUID()
    var trigger: MilestoneTrigger
    /// Voice / haptic / both.
    var alert: AlertStyle
    /// The haptic buzz used when `alert` contains `.haptic`.
    var haptic: HapticPattern = .notification
    /// Spoken text (when `.voice`) and the on-screen label for this milestone.
    /// If nil, a sensible default is derived from the trigger (e.g. "30 seconds").
    var label: String?

    /// The phrase spoken when this milestone fires.
    func spokenText(forDuration duration: TimeInterval) -> String {
        if let label, !label.isEmpty { return label }
        switch trigger {
        case .percentElapsed(let f):
            if abs(f - 0.5) < 0.001 { return "Halfway" }
            return "\(Int((f * 100).rounded())) percent"
        case .percentRemaining(let f):
            return "\(Int((f * 100).rounded())) percent remaining"
        case .secondsRemaining(let s):
            return Self.spokenDuration(s)
        }
    }

    /// The label shown in lists / editors.
    func displayLabel(forDuration duration: TimeInterval) -> String {
        if let label, !label.isEmpty { return label }
        switch trigger {
        case .percentElapsed(let f): return "At \(Int((f * 100).rounded()))%"
        case .percentRemaining(let f): return "\(Int((f * 100).rounded()))% left"
        case .secondsRemaining(let s): return "\(Self.spokenDuration(s)) left"
        }
    }

    /// "1 minute", "30 seconds", "1 minute 30 seconds".
    static func spokenDuration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let m = total / 60
        let s = total % 60
        switch (m, s) {
        case (0, _): return "\(s) second\(s == 1 ? "" : "s")"
        case (_, 0): return "\(m) minute\(m == 1 ? "" : "s")"
        default: return "\(m) minute\(m == 1 ? "" : "s") \(s) second\(s == 1 ? "" : "s")"
        }
    }
}
