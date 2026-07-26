import Foundation

/// Entry animation for an element; the exit animation is always the same
/// animation reversed, per product decision — one setting, symmetric feel.
///
/// Every style is expressed purely as a function of the element's resting
/// transform (centre, size, rotation, opacity) at a progress value, which is
/// why they all compose with blend modes, effects and magic-move transitions
/// for free — and why per-pixel ideas (blur reveals, mask wipes, per-glyph
/// typewriter) are deliberately absent: they'd need shader work, not a curve.
///
/// The catalogue is 20 styles chosen to cover the *feels* broadcast overlays
/// actually need — quiet fades and drifts for lower thirds, slides for
/// callouts, scales and springs for emphasis, wipes for bars, flips and
/// rotations for accents — rather than 20 variations of one idea. Anything
/// gaudy (spinning multiple turns, elastic rubber-banding, flying across the
/// frame diagonally) is left out on purpose.
struct EntryAnimation: Codable, Hashable, Sendable {
    enum Style: String, Codable, CaseIterable, Sendable {
        case none

        // Fade
        case fade

        // Slide: starts fully off-canvas beyond the near edge.
        case slideFromLeft
        case slideFromRight
        case slideFromTop
        case slideFromBottom

        // Drift: a short offset plus a fade. The restrained cousin of slide,
        // and the one to reach for on text over a face.
        case driftFromLeft
        case driftFromRight
        case riseUp
        case settleDown

        // Scale
        case scaleUp            // grows from 60% + fade
        case scaleDown          // arrives from 140% — reads as coming to rest
        case pop                // small overshoot past 100%

        // Spring / bounce: their own timing, so they ignore the curve setting.
        case springUp           // rises with a single soft overshoot
        case bounceIn           // decaying bounce on scale

        // Reveal: one axis grows from zero. Made for lower-third bars.
        case wipeFromCenterH
        case wipeFromCenterV
        case flipHorizontal     // width 0 → 1 with a slight overshoot
        case flipVertical

        // Rotation
        case rotateIn           // small tilt straightens out, with scale + fade
        case swingIn            // tilt oscillates and settles

        var displayName: String {
            switch self {
            case .none: "None"
            case .fade: "Fade"
            case .slideFromLeft: "Slide from Left"
            case .slideFromRight: "Slide from Right"
            case .slideFromTop: "Slide from Top"
            case .slideFromBottom: "Slide from Bottom"
            case .driftFromLeft: "Drift from Left"
            case .driftFromRight: "Drift from Right"
            case .riseUp: "Rise Up"
            case .settleDown: "Settle Down"
            case .scaleUp: "Scale Up"
            case .scaleDown: "Scale Down"
            case .pop: "Pop"
            case .springUp: "Spring Up"
            case .bounceIn: "Bounce In"
            case .wipeFromCenterH: "Wipe Horizontal"
            case .wipeFromCenterV: "Wipe Vertical"
            case .flipHorizontal: "Flip Horizontal"
            case .flipVertical: "Flip Vertical"
            case .rotateIn: "Rotate In"
            case .swingIn: "Swing In"
            }
        }

        /// Grouping for the inspector's picker — a flat list of 21 is a wall.
        enum Category: String, CaseIterable, Sendable {
            case none = "None"
            case fade = "Fade"
            case slide = "Slide"
            case drift = "Drift"
            case scale = "Scale"
            case spring = "Spring"
            case reveal = "Reveal"
            case rotate = "Rotate"
        }

        var category: Category {
            switch self {
            case .none: .none
            case .fade: .fade
            case .slideFromLeft, .slideFromRight, .slideFromTop, .slideFromBottom: .slide
            case .driftFromLeft, .driftFromRight, .riseUp, .settleDown: .drift
            case .scaleUp, .scaleDown, .pop: .scale
            case .springUp, .bounceIn: .spring
            case .wipeFromCenterH, .wipeFromCenterV, .flipHorizontal, .flipVertical: .reveal
            case .rotateIn, .swingIn: .rotate
            }
        }

        static func styles(in category: Category) -> [Style] {
            allCases.filter { $0.category == category }
        }

        /// Springs, bounces and oscillations *are* their own timing function;
        /// applying an ease on top muddies them, so `apply` runs these on
        /// linear progress. Styles that merely add an overshoot on top of the
        /// eased value (pop, the flips) still respect the curve.
        var definesOwnTiming: Bool {
            switch self {
            case .springUp, .bounceIn, .swingIn: true
            default: false
            }
        }

        /// A duration that flatters this style, used when the user picks it so
        /// a bounce doesn't inherit a fade's 0.35s and look broken.
        var suggestedDuration: TimeInterval {
            switch self {
            case .none: 0
            case .fade, .driftFromLeft, .driftFromRight, .riseUp, .settleDown: 0.35
            case .slideFromLeft, .slideFromRight, .slideFromTop, .slideFromBottom: 0.45
            case .scaleUp, .scaleDown: 0.4
            case .pop, .wipeFromCenterH, .wipeFromCenterV: 0.35
            case .flipHorizontal, .flipVertical, .rotateIn: 0.5
            case .springUp, .swingIn: 0.6
            case .bounceIn: 0.75
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

    /// The same animation with the duration that suits its style.
    static func styled(_ style: Style, curve: Curve = .easeOut) -> EntryAnimation {
        EntryAnimation(style: style, duration: style.suggestedDuration, curve: curve)
    }

    /// Evaluates the animated transform at `progress` (0 = fully out /
    /// hidden, 1 = fully in / resting). Exit runs the same evaluation with
    /// progress moving 1 → 0, which is exactly "the reverse of entry".
    ///
    /// Every style must land exactly on `resting` at progress 1 and be fully
    /// invisible at 0 — otherwise elements drift or flash on show/hide.
    func apply(progress: Double, to resting: ElementTransform) -> ElementTransform {
        let clamped = min(max(progress, 0), 1)
        let p = style.definesOwnTiming ? clamped : curve.value(clamped)
        var t = resting

        switch style {
        case .none:
            t.opacity = clamped > 0 ? resting.opacity : 0

        case .fade:
            t.opacity = resting.opacity * p

        // MARK: Slide

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
            t.center = Self.lerp(start, resting.center, p)
            // Slight fade at the very start so the first visible frame isn't harsh.
            t.opacity = resting.opacity * min(1, p * 4)

        // MARK: Drift — a short offset, never off-canvas

        case .driftFromLeft, .driftFromRight, .riseUp, .settleDown:
            let distance = 0.06
            var start = resting.center
            switch style {
            case .driftFromLeft: start.x -= distance
            case .driftFromRight: start.x += distance
            case .riseUp: start.y += distance          // starts low, rises to rest
            case .settleDown: start.y -= distance      // starts high, settles down
            default: break
            }
            t.center = Self.lerp(start, resting.center, p)
            t.opacity = resting.opacity * p

        // MARK: Scale

        case .scaleUp:
            t.size = Self.scaled(resting.size, by: 0.6 + 0.4 * p)
            t.opacity = resting.opacity * p

        case .scaleDown:
            t.size = Self.scaled(resting.size, by: 1.4 - 0.4 * p)
            t.opacity = resting.opacity * p

        case .pop:
            // 0 → 1.06 → 1: a single hump that lands exactly at rest.
            t.size = Self.scaled(resting.size, by: Self.overshoot(p, by: 0.06))
            t.opacity = resting.opacity * min(1, p * 3)

        // MARK: Spring / bounce

        case .springUp:
            let eased = Self.easeOutBack(p, overshoot: 1.2)
            var start = resting.center
            start.y += 0.08
            t.center = Self.lerp(start, resting.center, eased)
            t.opacity = resting.opacity * min(1, p * 3)

        case .bounceIn:
            let bounced = Self.easeOutBounce(p)
            t.size = Self.scaled(resting.size, by: bounced)
            t.opacity = resting.opacity * min(1, p * 4)

        // MARK: Reveal — one axis grows from nothing

        case .wipeFromCenterH:
            t.size = CGSize(width: resting.size.width * p, height: resting.size.height)
            t.opacity = resting.opacity

        case .wipeFromCenterV:
            t.size = CGSize(width: resting.size.width, height: resting.size.height * p)
            t.opacity = resting.opacity

        case .flipHorizontal:
            // Width 0 → 1 with a touch of overshoot: reads like a card turning.
            t.size = CGSize(width: resting.size.width * Self.overshoot(p, by: 0.08),
                            height: resting.size.height)
            t.opacity = resting.opacity * min(1, p * 5)

        case .flipVertical:
            t.size = CGSize(width: resting.size.width,
                            height: resting.size.height * Self.overshoot(p, by: 0.08))
            t.opacity = resting.opacity * min(1, p * 5)

        // MARK: Rotation

        case .rotateIn:
            let radians = -8.0 * .pi / 180
            t.rotation = resting.rotation + radians * (1 - p)
            t.size = Self.scaled(resting.size, by: 0.85 + 0.15 * p)
            t.opacity = resting.opacity * p

        case .swingIn:
            // Decaying oscillation that reaches exactly zero offset at p = 1.
            let amplitude = 10.0 * .pi / 180
            let decay = pow(1 - p, 2)
            t.rotation = resting.rotation + amplitude * decay * cos(p * 3 * .pi)
            t.opacity = resting.opacity * min(1, p * 4)
        }

        return t
    }

    // MARK: - Timing helpers

    private static func lerp(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    }

    private static func scaled(_ size: CGSize, by factor: Double) -> CGSize {
        CGSize(width: size.width * factor, height: size.height * factor)
    }

    /// A single hump above 1 that returns to exactly 1 at p = 1.
    private static func overshoot(_ p: Double, by amount: Double) -> Double {
        p + amount * sin(p * .pi)
    }

    /// Classic "back" ease: pulls slightly past the target then settles.
    /// f(0) = 0, f(1) = 1.
    private static func easeOutBack(_ p: Double, overshoot c1: Double) -> Double {
        let c3 = c1 + 1
        let x = p - 1
        return 1 + c3 * pow(x, 3) + c1 * pow(x, 2)
    }

    /// Standard decaying bounce. f(0) = 0, f(1) = 1.
    private static func easeOutBounce(_ p: Double) -> Double {
        let n1 = 7.5625, d1 = 2.75
        var x = p
        if x < 1 / d1 {
            return n1 * x * x
        } else if x < 2 / d1 {
            x -= 1.5 / d1
            return n1 * x * x + 0.75
        } else if x < 2.5 / d1 {
            x -= 2.25 / d1
            return n1 * x * x + 0.9375
        } else {
            x -= 2.625 / d1
            return n1 * x * x + 0.984375
        }
    }
}
