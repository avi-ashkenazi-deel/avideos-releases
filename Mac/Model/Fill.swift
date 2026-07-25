import Foundation
import CoreGraphics

/// A fill paints the interior of a shape/text element — or a stroke, since
/// strokes carry a `Fill` too (that's how animated/video strokes come free).
enum Fill: Codable, Hashable, Sendable {
    case solid(RGBAColor)
    /// A moving, procedurally animated Metal fill (gradient sweeps, plasma,
    /// scanlines…). Parameters are interpreted by the named shader.
    case shader(ShaderFill)
    /// A looping video used as paint.
    case video(MediaReference)
}

/// Named procedural fills implemented in `Shaders/ShaderFills.metal`.
/// `FillKind`'s rawValue is the shader dispatch selector — keep in sync.
struct ShaderFill: Codable, Hashable, Sendable {
    enum Kind: String, Codable, CaseIterable, Sendable {
        case linearGradientSweep   // two-color gradient whose angle rotates
        case plasma                // classic smooth-noise plasma
        case waves                 // horizontal sine bands drifting
        case sparkle               // twinkling points over a base color
    }

    var kind: Kind
    var colorA: RGBAColor
    var colorB: RGBAColor
    /// Animation speed multiplier; 1 = shader's natural pace, 0 = frozen.
    var speed: Double
    /// Feature scale (band width, noise zoom…), 0.1…4, shader-interpreted.
    var scale: Double

    init(kind: Kind = .linearGradientSweep,
         colorA: RGBAColor = RGBAColor(red: 0.35, green: 0.2, blue: 0.9),
         colorB: RGBAColor = RGBAColor(red: 0.05, green: 0.75, blue: 0.9),
         speed: Double = 1,
         scale: Double = 1) {
        self.kind = kind
        self.colorA = colorA
        self.colorB = colorB
        self.speed = speed
        self.scale = scale
    }
}

/// Outline drawn around an element's bounds (every element kind except a bare
/// fill supports one). The stroke's paint is itself a `Fill`, so solid,
/// animated-shader, and video strokes all work — and animate — identically.
struct Stroke: Codable, Hashable, Sendable {
    /// Width in unit-canvas terms (fraction of canvas width); 0.004 ≈ 8px at 1080p.
    var width: Double
    var fill: Fill
    /// Corner radius in unit terms, matched to the element's own radius when nil.
    var cornerRadius: Double?

    init(width: Double = 0.004,
         fill: Fill = .solid(.white),
         cornerRadius: Double? = nil) {
        self.width = width
        self.fill = fill
        self.cornerRadius = cornerRadius
    }
}
