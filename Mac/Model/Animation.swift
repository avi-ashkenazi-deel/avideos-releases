import Foundation

/// Entry animation for an element; the exit animation is always the same
/// animation reversed, per product decision — one setting, symmetric feel.
struct EntryAnimation: Codable, Hashable, Sendable {
    enum Style: String, Codable, CaseIterable, Sendable {
        case none
        case fade
        case slideFromLeft
        case slideFromRight
        case slideFromTop
        case slideFromBottom
        case scaleUp        // grows from 60% + fade
        case pop            // slight overshoot past 100%

        var displayName: String {
            switch self {
            case .none: "None"
            case .fade: "Fade"
            case .slideFromLeft: "Slide from Left"
            case .slideFromRight: "Slide from Right"
            case .slideFromTop: "Slide from Top"
            case .slideFromBottom: "Slide from Bottom"
            case .scaleUp: "Scale Up"
            case .pop: "Pop"
            }
        }
    }

    enum Curve: String, Codable, CaseIterable, Sendable {
        case linear
        case easeIn
        case easeOut
        case easeInOut

        /// Maps linear progress 0…1 to eased progress.
        func value(_ t: Double) -> Double {
            let t = min(max(t, 0), 1)
            switch self {
            case .linear: return t
            case .easeIn: return t * t
            case .easeOut: return 1 - (1 - t) * (1 - t)
            case .easeInOut:
                return t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            }
        }
    }

    var style: Style
    var duration: TimeInterval
    var curve: Curve

    init(style: Style = .none, duration: TimeInterval = 0.35, curve: Curve = .easeOut) {
        self.style = style
        self.duration = duration
        self.curve = curve
    }

    /// Evaluates the animated transform at `progress` (0 = fully out /
    /// hidden, 1 = fully in / resting). Exit runs the same evaluation with
    /// progress moving 1 → 0, which is exactly "the reverse of entry".
    func apply(progress: Double, to resting: ElementTransform) -> ElementTransform {
        let p = curve.value(progress)
        var t = resting
        switch style {
        case .none:
            t.opacity = progress > 0 ? resting.opacity : 0
        case .fade:
            t.opacity = resting.opacity * p
        case .slideFromLeft, .slideFromRight, .slideFromTop, .slideFromBottom:
            // Start fully off-canvas just beyond the near edge, glide to rest.
            var start = resting.center
            switch style {
            case .slideFromLeft: start.x = -resting.size.width / 2 - 0.02
            case .slideFromRight: start.x = 1 + resting.size.width / 2 + 0.02
            case .slideFromTop: start.y = -resting.size.height / 2 - 0.02
            case .slideFromBottom: start.y = 1 + resting.size.height / 2 + 0.02
            default: break
            }
            t.center = CGPoint(x: start.x + (resting.center.x - start.x) * p,
                               y: start.y + (resting.center.y - start.y) * p)
            // Slight fade at the very start so the first visible frame isn't harsh.
            t.opacity = resting.opacity * min(1, p * 4)
        case .scaleUp:
            let s = 0.6 + 0.4 * p
            t.size = CGSize(width: resting.size.width * s, height: resting.size.height * s)
            t.opacity = resting.opacity * p
        case .pop:
            // Overshoot: 0 → 1.06 → 1 (single-hump added on top of ease).
            let overshoot = p + 0.06 * sin(p * .pi)
            t.size = CGSize(width: resting.size.width * overshoot,
                            height: resting.size.height * overshoot)
            t.opacity = resting.opacity * min(1, p * 3)
        }
        return t
    }
}
