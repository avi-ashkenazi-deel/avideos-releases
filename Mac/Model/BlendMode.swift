import Foundation

/// After-Effects-style blend modes, implemented per the W3C compositing spec
/// formulas in `Shaders/Blend.metal`. `.normal` uses fixed-function alpha
/// blending (fast path); everything else runs the ping-pong blend pass.
/// The rawValue is the Metal function constant index — keep in sync with
/// `BlendModeIndex` in Blend.metal.
enum BlendMode: Int, Codable, CaseIterable, Hashable, Sendable {
    case normal = 0
    case multiply = 1
    case screen = 2
    case overlay = 3
    case darken = 4
    case lighten = 5
    case colorDodge = 6
    case colorBurn = 7
    case hardLight = 8
    case softLight = 9
    case difference = 10
    case exclusion = 11

    var displayName: String {
        switch self {
        case .normal: "Normal"
        case .multiply: "Multiply"
        case .screen: "Screen"
        case .overlay: "Overlay"
        case .darken: "Darken"
        case .lighten: "Lighten"
        case .colorDodge: "Color Dodge"
        case .colorBurn: "Color Burn"
        case .hardLight: "Hard Light"
        case .softLight: "Soft Light"
        case .difference: "Difference"
        case .exclusion: "Exclusion"
        }
    }

    /// Whether compositing this mode needs to sample the destination
    /// (ping-pong pass) or can use fixed-function blending.
    var needsDestinationSample: Bool { self != .normal }
}
