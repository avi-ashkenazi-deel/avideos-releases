import Foundation

/// Time-driven scroll position source. `offset(at:)` is designed to be sampled
/// once per frame from a display link / `TimelineView(.animation)`; all other
/// calls mutate targets and take effect on the next sample.
///
/// The offset is the content-space Y coordinate currently sitting at the
/// panel's eye line (not the top edge) — jumping to a section puts that
/// section's first line where the host is actually reading.
protocol ScrollEngine: AnyObject {
    func offset(at time: TimeInterval) -> CGFloat
    func play(at time: TimeInterval)
    func pause(at time: TimeInterval)
    func setSpeed(_ multiplier: Double, at time: TimeInterval)
    func nudge(lines: Int, at time: TimeInterval)
    func jump(to offset: CGFloat, at time: TimeInterval)
}

/// Layout inputs that convert reading pace (words/minute) into px/s.
struct ScrollLayoutMetrics: Equatable {
    var fontSize: CGFloat = 40
    var panelWidth: CGFloat = 480
    var horizontalPadding: CGFloat = 56

    var lineHeight: CGFloat {
        // Matches the SwiftUI column's effective line box for a system font
        // with default leading; close enough for pacing (exact metrics vary
        // by a few percent and the host nudges/speed-trims anyway).
        (fontSize * 1.3).rounded()
    }

    var wordsPerLine: Double {
        // Average glyph advance ~0.5× point size for SF; average English word
        // ~5.1 characters plus a space.
        let textWidth = max(panelWidth - horizontalPadding, fontSize)
        let charsPerLine = Double(textWidth / (fontSize * 0.5))
        return max(1, charsPerLine / 6.1)
    }
}

/// Words-per-minute scroll driver with eased speed transitions.
final class TimedScrollDriver: ScrollEngine {
    static let wordsPerMinuteRange: ClosedRange<Double> = 80...220
    static let speedMultiplierRange: ClosedRange<Double> = 0.5...2.0

    private(set) var metrics = ScrollLayoutMetrics()
    private(set) var wordsPerMinute: Double = 150
    private(set) var speedMultiplier: Double = 1.0
    private(set) var isPlaying = false

    /// Upper clamp for the offset; the controller sets this to the measured
    /// content height so the script can scroll fully past the eye line.
    var maxOffset: CGFloat = .greatestFiniteMagnitude

    // Eased velocity state: current velocity ramps toward `targetVelocity`
    // over `rampDuration` (smoothstep) so remote ±0.1 taps feel analog.
    private var position: CGFloat = 0
    private var lastSampleTime: TimeInterval?
    private var rampStartVelocity: Double = 0
    private var rampStartTime: TimeInterval = -1
    private var targetVelocity: Double = 0
    private let rampDuration: TimeInterval = 0.4

    // MARK: - Sampling

    func offset(at time: TimeInterval) -> CGFloat {
        guard let last = lastSampleTime else {
            lastSampleTime = time
            return position
        }
        let dt = time - last
        guard dt > 0 else { return position }
        lastSampleTime = time
        // Midpoint integration of the eased velocity; at display-link rates the
        // error vs. the analytic integral is far below a pixel.
        let midVelocity = easedVelocity(at: last + dt / 2)
        position = clamp(position + CGFloat(midVelocity * dt))
        return position
    }

    // MARK: - Transport

    func play(at time: TimeInterval) {
        settle(at: time)
        isPlaying = true
        retarget(naturalVelocity, at: time)
    }

    /// Immediate stop (no ramp-out): position is preserved exactly at the
    /// pause instant so resume continues from the same line.
    func pause(at time: TimeInterval) {
        settle(at: time)
        isPlaying = false
        rampStartVelocity = 0
        targetVelocity = 0
        rampStartTime = time - rampDuration
    }

    func setSpeed(_ multiplier: Double, at time: TimeInterval) {
        settle(at: time)
        speedMultiplier = multiplier.clamped(to: Self.speedMultiplierRange)
        if isPlaying { retarget(naturalVelocity, at: time) }
    }

    func setWordsPerMinute(_ wpm: Double, at time: TimeInterval) {
        settle(at: time)
        wordsPerMinute = wpm.clamped(to: Self.wordsPerMinuteRange)
        if isPlaying { retarget(naturalVelocity, at: time) }
    }

    func nudge(lines: Int, at time: TimeInterval) {
        settle(at: time)
        position = clamp(position + CGFloat(lines) * metrics.lineHeight)
    }

    func jump(to offset: CGFloat, at time: TimeInterval) {
        settle(at: time)
        position = clamp(offset)
    }

    /// Font size / panel width changed; px-per-second is recomputed while the
    /// current position is preserved.
    func updateLayout(_ newMetrics: ScrollLayoutMetrics, at time: TimeInterval) {
        guard newMetrics != metrics else { return }
        settle(at: time)
        metrics = newMetrics
        if isPlaying { retarget(naturalVelocity, at: time) }
    }

    // MARK: - Internals

    private var naturalVelocity: Double {
        let effectiveWPM = wordsPerMinute.clamped(to: Self.wordsPerMinuteRange) * speedMultiplier
        let linesPerSecond = effectiveWPM / metrics.wordsPerLine / 60
        return linesPerSecond * Double(metrics.lineHeight)
    }

    private func easedVelocity(at time: TimeInterval) -> Double {
        let t = (time - rampStartTime) / rampDuration
        if t >= 1 { return targetVelocity }
        if t <= 0 { return rampStartVelocity }
        let s = t * t * (3 - 2 * t) // smoothstep
        return rampStartVelocity + (targetVelocity - rampStartVelocity) * s
    }

    private func retarget(_ newTarget: Double, at time: TimeInterval) {
        rampStartVelocity = easedVelocity(at: time)
        rampStartTime = time
        targetVelocity = newTarget
    }

    /// Advances the integrator up to `time` before a state change so the
    /// change never rewrites history.
    private func settle(at time: TimeInterval) {
        _ = offset(at: time)
        lastSampleTime = time
    }

    private func clamp(_ value: CGFloat) -> CGFloat {
        min(max(0, value), max(0, maxOffset))
    }
}

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(range.lowerBound, self), range.upperBound)
    }
}
