import Foundation

/// An ordered, composable chain of video effects. Applied texture-in/
/// texture-out by `EffectChainRenderer`, so chains compose freely with blend
/// modes and any element/scene can carry one.
struct EffectChain: Codable, Hashable, Sendable {
    var effects: [VideoEffectSpec]

    init(effects: [VideoEffectSpec] = []) {
        self.effects = effects
    }

    var isEmpty: Bool { effects.isEmpty }
}

/// The document-side description of one effect. The render side maps each
/// case to a `VideoEffect` implementation (Metal kernel, CIFilter recipe, or
/// Vision-assisted pass).
enum VideoEffectSpec: Codable, Hashable, Sendable, Identifiable {
    /// Broadcast utility screens: replace output with a constant color.
    case whiteScreen
    case greenScreen
    case blackScreen
    /// Green-screen (or any-color) keying.
    case chromaKey(ChromaKeyParams)
    /// Person segmentation → replace/blur everything that isn't you.
    case virtualBackground(VirtualBackgroundParams)
    /// -1…1, 0 = neutral.
    case contrast(Double)
    /// 0…1 sharpen intensity.
    case sharpen(Double)
    /// 0…1 skin-smoothing strength.
    case beautify(Double)

    var id: String { caseName }

    var caseName: String {
        switch self {
        case .whiteScreen: "whiteScreen"
        case .greenScreen: "greenScreen"
        case .blackScreen: "blackScreen"
        case .chromaKey: "chromaKey"
        case .virtualBackground: "virtualBackground"
        case .contrast: "contrast"
        case .sharpen: "sharpen"
        case .beautify: "beautify"
        }
    }

    var displayName: String {
        switch self {
        case .whiteScreen: "White Screen"
        case .greenScreen: "Green Screen"
        case .blackScreen: "Black Screen"
        case .chromaKey: "Chroma Key"
        case .virtualBackground: "Virtual Background"
        case .contrast: "Contrast"
        case .sharpen: "Sharpen"
        case .beautify: "Beautify"
        }
    }
}

struct ChromaKeyParams: Codable, Hashable, Sendable {
    var keyColor: RGBAColor
    /// CbCr-distance below which pixels are fully keyed out, 0…1.
    var similarity: Double
    /// Softness band above `similarity`, 0…1.
    var smoothness: Double
    /// 0…1 spill-suppression amount (desaturate key-colored fringes).
    var spillSuppression: Double

    init(keyColor: RGBAColor = .keyGreen,
         similarity: Double = 0.4,
         smoothness: Double = 0.1,
         spillSuppression: Double = 0.5) {
        self.keyColor = keyColor
        self.similarity = similarity
        self.smoothness = smoothness
        self.spillSuppression = spillSuppression
    }
}

struct VirtualBackgroundParams: Codable, Hashable, Sendable {
    enum Background: Codable, Hashable, Sendable {
        /// Gaussian-blur the real background (radius 0…1 normalized).
        case blur(radius: Double)
        case image(MediaReference)
        case video(MediaReference)
        case color(RGBAColor)
    }

    var background: Background
    /// Extra feathering of the person mask edge, 0…1.
    var edgeSoftness: Double

    init(background: Background = .blur(radius: 0.5), edgeSoftness: Double = 0.3) {
        self.background = background
        self.edgeSoftness = edgeSoftness
    }
}
