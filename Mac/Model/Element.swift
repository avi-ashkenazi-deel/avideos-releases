import Foundation
import CoreGraphics

/// One overlay layer in a scene: text, a shape, an image, a video, a live web
/// page, or an inset live source (camera / guest / screen picture-in-picture).
struct Element: Codable, Hashable, Sendable, Identifiable {
    var id: UUID
    var name: String
    var kind: ElementKind
    var transform: ElementTransform
    /// Paint for shape/text content; ignored by image/video/web/source kinds.
    var fill: Fill?
    var stroke: Stroke?
    var blendMode: BlendMode
    var effects: EffectChain
    var entryAnimation: EntryAnimation
    var isVisible: Bool
    var isLocked: Bool
    /// Tile shape for `.source` elements (camera/guest PiP): aspect preset +
    /// mask, Ecamm-style. nil = plain rectangle. Optional so old files decode.
    var tileShape: SourceTileShape?
    /// Unit corner radius applied to ANY element kind — images, videos, web,
    /// tiles, shapes alike ("border radius for everything"). nil = the
    /// kind's own default. Optional so old files decode.
    var cornerRadius: Double?

    init(id: UUID = UUID(),
         name: String,
         kind: ElementKind,
         transform: ElementTransform = ElementTransform(),
         fill: Fill? = nil,
         stroke: Stroke? = nil,
         blendMode: BlendMode = .normal,
         effects: EffectChain = EffectChain(),
         entryAnimation: EntryAnimation = EntryAnimation(),
         isVisible: Bool = true,
         isLocked: Bool = false) {
        self.id = id
        self.name = name
        self.kind = kind
        self.transform = transform
        self.fill = fill
        self.stroke = stroke
        self.blendMode = blendMode
        self.effects = effects
        self.entryAnimation = entryAnimation
        self.isVisible = isVisible
        self.isLocked = isLocked
    }

    /// Identity used by the scene-transition engine to match "the same thing"
    /// across two scenes so it can glide instead of cut. Content beats
    /// identity where content IS the identity: the same image file in two
    /// scenes is the same picture wherever it came from, so it matches by
    /// path and glides — element ids only break the tie for text/shapes
    /// (same id = a duplicated scene's sibling), with the engine's
    /// proximity pass catching the rest.
    var transitionKey: String {
        switch kind {
        case .image(let media): return "image:\(media.path)"
        case .video(let content): return "video:\(content.media.path)"
        case .web(let content): return "web:\(content.urlString)"
        default: break
        }
        if case .source(let binding) = kind {
            switch binding {
            // "" means the system default; match the token RenderPlan's
            // primaries use, so a default-camera tile and a default-camera
            // scene primary are the same thing to magic move.
            case .camera(let uid): return "camera:\(uid.isEmpty ? "default" : uid)"
            case .guest(let identity): return "guest:\(identity)"
            case .display(let d): return "display:\(d)"
            case .window(let w): return "window:\(w)"
            }
        }
        return id.uuidString
    }
}

enum ElementKind: Codable, Hashable, Sendable {
    case text(TextContent)
    case shape(ShapeContent)
    case image(MediaReference)
    case video(VideoContent)
    case web(WebContent)
    /// Live source inset (camera PiP, a guest tile, a screen region).
    case source(SourceBinding)
    /// Countdown overlay — renders as text that ticks once a second.
    case timer(TimerContent)

    var displayName: String {
        switch self {
        case .text: "Text"
        case .shape: "Shape"
        case .image: "Image"
        case .video: "Video"
        case .web: "Web Page"
        case .source: "Source"
        case .timer: "Timer"
        }
    }
}

struct TextContent: Codable, Hashable, Sendable {
    var string: String
    /// PostScript name; empty = system font.
    var fontName: String
    /// Point size at 1080p reference; scales with canvas.
    var fontSize: Double
    var alignment: Alignment
    var lineSpacing: Double
    /// Background box behind the glyphs (the "text box" overlay). Optional
    /// twice over: nil = plain text, and old project files lack the keys.
    var boxFill: Fill?
    /// Unit corner radius of the box; nil = a small default.
    var boxCornerRadius: Double?

    enum Alignment: String, Codable, CaseIterable, Sendable {
        case leading, center, trailing
    }

    init(string: String = "Text",
         fontName: String = "",
         fontSize: Double = 64,
         alignment: Alignment = .center,
         lineSpacing: Double = 1.1,
         boxFill: Fill? = nil,
         boxCornerRadius: Double? = nil) {
        self.string = string
        self.fontName = fontName
        self.fontSize = fontSize
        self.alignment = alignment
        self.lineSpacing = lineSpacing
        self.boxFill = boxFill
        self.boxCornerRadius = boxCornerRadius
    }
}

/// Tile shape for a source inset (camera / guest PiP): an aspect preset and
/// its mask. The aspect applies when picked (it rewrites the element's
/// transform); the mask applies every frame.
enum SourceTileShape: String, Codable, CaseIterable, Sendable {
    case wide       // 16:9
    case classic    // 4:3
    case square
    case circle
    case squircle
    case tall       // 9:16

    var displayName: String {
        switch self {
        case .wide: "Wide (16:9)"
        case .classic: "Classic (4:3)"
        case .square: "Square"
        case .circle: "Circle"
        case .squircle: "Squircle"
        case .tall: "Tall (9:16)"
        }
    }

    /// Content aspect (width / height).
    var aspect: Double {
        switch self {
        case .wide: 16.0 / 9.0
        case .classic: 4.0 / 3.0
        case .square, .circle, .squircle: 1
        case .tall: 9.0 / 16.0
        }
    }

    /// Unit corner radius for the render item; -1 is the ellipse-mask
    /// sentinel the compositor already understands.
    var cornerRadius: Double {
        switch self {
        case .circle: -1
        case .squircle: 0.22
        default: 0.02
        }
    }
}

/// Countdown state that persists: how long, and how it's drawn. The running
/// clock (when it was started) is runtime state on StudioController — a saved
/// project must not resume mid-count.
struct TimerContent: Codable, Hashable, Sendable {
    var durationSeconds: Double
    var fontName: String
    /// Point size at 1080p reference, like TextContent.
    var fontSize: Double

    init(durationSeconds: Double = 300,
         fontName: String = "",
         fontSize: Double = 140) {
        self.durationSeconds = durationSeconds
        self.fontName = fontName
        self.fontSize = fontSize
    }

    /// "3:21", or "1:02:05" past the hour — what the tile shows.
    static func formatted(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, secs)
                         : String(format: "%d:%02d", minutes, secs)
    }
}

struct ShapeContent: Codable, Hashable, Sendable {
    enum Shape: String, Codable, CaseIterable, Sendable {
        case rectangle
        case roundedRectangle
        case ellipse
        case line
    }

    var shape: Shape
    /// Unit corner radius for roundedRectangle.
    var cornerRadius: Double

    init(shape: Shape = .rectangle, cornerRadius: Double = 0.02) {
        self.shape = shape
        self.cornerRadius = cornerRadius
    }
}

struct VideoContent: Codable, Hashable, Sendable {
    var media: MediaReference
    var loops: Bool
    var isMuted: Bool

    init(media: MediaReference, loops: Bool = true, isMuted: Bool = true) {
        self.media = media
        self.loops = loops
        self.isMuted = isMuted
    }
}

struct WebContent: Codable, Hashable, Sendable {
    var urlString: String
    /// Pixel size the page is laid out at (element transform scales it onto canvas).
    var pageSize: CGSize
    /// Snapshot cadence; web overlays are for lower-thirds/countdowns, not 60fps motion.
    var refreshFPS: Int

    init(urlString: String = "https://",
         pageSize: CGSize = CGSize(width: 1920, height: 1080),
         refreshFPS: Int = 10) {
        self.urlString = urlString
        self.pageSize = pageSize
        self.refreshFPS = refreshFPS
    }
}
