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
    /// across two scenes so it can glide instead of cut: explicit element id
    /// wins, else the source binding (e.g. the same guest's tile in two
    /// layouts), else nothing matches and entry/exit animations play.
    var transitionKey: String {
        if case .source(let binding) = kind {
            switch binding {
            case .camera(let uid): return "camera:\(uid)"
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

    var displayName: String {
        switch self {
        case .text: "Text"
        case .shape: "Shape"
        case .image: "Image"
        case .video: "Video"
        case .web: "Web Page"
        case .source: "Source"
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

    enum Alignment: String, Codable, CaseIterable, Sendable {
        case leading, center, trailing
    }

    init(string: String = "Text",
         fontName: String = "",
         fontSize: Double = 64,
         alignment: Alignment = .center,
         lineSpacing: Double = 1.1) {
        self.string = string
        self.fontName = fontName
        self.fontSize = fontSize
        self.alignment = alignment
        self.lineSpacing = lineSpacing
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
