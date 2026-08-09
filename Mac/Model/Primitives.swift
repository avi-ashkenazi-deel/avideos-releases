import Foundation
import CoreGraphics

/// Document schema version, bumped on breaking model changes.
/// `ProjectStore` refuses to silently load newer documents and migrates older ones.
enum ModelSchema {
    static let version = 1
}

/// Color as plain doubles so the document stays engine-agnostic (SwiftUI,
/// Metal clear colors, and CoreGraphics all convert trivially).
struct RGBAColor: Codable, Hashable, Sendable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double

    init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    static let white = RGBAColor(red: 1, green: 1, blue: 1)
    static let black = RGBAColor(red: 0, green: 0, blue: 0)
    static let clear = RGBAColor(red: 0, green: 0, blue: 0, alpha: 0)
    /// Studio-green default for chroma key (matches typical green screens).
    static let keyGreen = RGBAColor(red: 0.0, green: 0.7, blue: 0.25)
}

/// Element placement on the canvas in **unit coordinates** (0…1 on both axes,
/// y-down like design tools), so documents are resolution-independent: the
/// same project renders at 1080p live and 4K in export.
struct ElementTransform: Codable, Hashable, Sendable {
    /// Center of the element, unit coords.
    var center: CGPoint
    /// Size, unit coords (relative to canvas width/height).
    var size: CGSize
    /// Rotation around center, radians, clockwise (y-down space).
    var rotation: Double
    /// 0…1.
    var opacity: Double

    // MARK: 3D-ish placement
    //
    // All Optional so existing documents decode unchanged (a synthesized
    // Decodable treats Optional properties as decodeIfPresent). Read them
    // through the non-optional accessors below.

    /// Tilt about the horizontal axis, radians — the top edge leans away or
    /// toward the viewer. The gimbal's vertical drag.
    var tiltX: Double?
    /// Turn about the vertical axis, radians — the left/right edge leans.
    /// The gimbal's horizontal drag.
    var tiltY: Double?
    /// Shear factors: x shifts with y, y shifts with x. Independent of tilt,
    /// for the flat-parallelogram look.
    var skew: CGPoint?
    /// Fake extrusion depth in unit canvas width — the element is drawn as a
    /// short stack of darkened copies receding along its 3D normal, which
    /// reads as thickness without a real 3D pipeline.
    var depth: Double?
    /// How strong the perspective is: the virtual camera distance in units of
    /// the element's own size. Small = wide-angle drama, large = orthographic.
    var perspective: Double?

    var tiltXValue: Double { tiltX ?? 0 }
    var tiltYValue: Double { tiltY ?? 0 }
    var skewValue: CGPoint { skew ?? .zero }
    var depthValue: Double { depth ?? 0 }
    /// 2.5 is a natural-looking default (≈35° field of view over the quad).
    var perspectiveValue: Double { max(perspective ?? 2.5, 0.4) }

    // Non-optional views of the same storage, so UI can bind with a plain
    // WritableKeyPath (a Binding to an Optional slider value is misery).
    // Writing a neutral value clears the field, keeping saved documents free
    // of no-op keys.
    var tiltXNonOptional: Double {
        get { tiltXValue }
        set { tiltX = newValue == 0 ? nil : newValue }
    }
    var tiltYNonOptional: Double {
        get { tiltYValue }
        set { tiltY = newValue == 0 ? nil : newValue }
    }
    var skewXNonOptional: Double {
        get { Double(skewValue.x) }
        set {
            let point = CGPoint(x: newValue, y: skewValue.y)
            skew = point == .zero ? nil : point
        }
    }
    var skewYNonOptional: Double {
        get { Double(skewValue.y) }
        set {
            let point = CGPoint(x: skewValue.x, y: newValue)
            skew = point == .zero ? nil : point
        }
    }
    var depthNonOptional: Double {
        get { depthValue }
        set { depth = newValue <= 0 ? nil : newValue }
    }
    var perspectiveNonOptional: Double {
        get { perspectiveValue }
        set { perspective = newValue }
    }
    /// Is any 3D-ish field doing something? Lets the renderer keep the plain
    /// affine path for the overwhelmingly common flat element.
    var hasDepthEffects: Bool {
        tiltXValue != 0 || tiltYValue != 0
            || skewValue != .zero || depthValue > 0
    }

    init(center: CGPoint = CGPoint(x: 0.5, y: 0.5),
         size: CGSize = CGSize(width: 0.4, height: 0.3),
         rotation: Double = 0,
         opacity: Double = 1,
         tiltX: Double? = nil,
         tiltY: Double? = nil,
         skew: CGPoint? = nil,
         depth: Double? = nil,
         perspective: Double? = nil) {
        self.center = center
        self.size = size
        self.rotation = rotation
        self.opacity = opacity
        self.tiltX = tiltX
        self.tiltY = tiltY
        self.skew = skew
        self.depth = depth
        self.perspective = perspective
    }

    static let fullCanvas = ElementTransform(
        center: CGPoint(x: 0.5, y: 0.5),
        size: CGSize(width: 1, height: 1)
    )

    /// Linear interpolation, used by entry/exit animation evaluation and the
    /// scene-transition engine ("magic move").
    static func lerp(_ a: ElementTransform, _ b: ElementTransform, _ t: Double) -> ElementTransform {
        let t = min(max(t, 0), 1)
        func mix(_ x: Double, _ y: Double) -> Double { x + (y - x) * t }
        return ElementTransform(
            center: CGPoint(x: a.center.x + (b.center.x - a.center.x) * t,
                            y: a.center.y + (b.center.y - a.center.y) * t),
            size: CGSize(width: a.size.width + (b.size.width - a.size.width) * t,
                         height: a.size.height + (b.size.height - a.size.height) * t),
            rotation: mix(a.rotation, b.rotation),
            opacity: mix(a.opacity, b.opacity),
            // Interpolated too, so magic move can tilt a flat tile into a
            // perspective one across a scene switch.
            tiltX: mix(a.tiltXValue, b.tiltXValue),
            tiltY: mix(a.tiltYValue, b.tiltYValue),
            skew: CGPoint(x: mix(Double(a.skewValue.x), Double(b.skewValue.x)),
                          y: mix(Double(a.skewValue.y), Double(b.skewValue.y))),
            depth: mix(a.depthValue, b.depthValue),
            perspective: mix(a.perspectiveValue, b.perspectiveValue)
        )
    }
}

/// A file the document references (image, video, song, sound effect).
/// Stored as a bookmark so renames/moves survive; the absolute path is kept
/// as a fallback and for human-readable diffing of the JSON document.
struct MediaReference: Codable, Hashable, Sendable {
    var displayName: String
    var bookmark: Data?
    var path: String

    init(url: URL) {
        self.displayName = url.lastPathComponent
        self.path = url.path
        // Security-scoped bookmarks work unsandboxed too and keep the door
        // open to sandboxing later without a document migration.
        self.bookmark = try? url.bookmarkData(options: [.withSecurityScope])
    }

    /// Resolves back to a URL, preferring the bookmark.
    func resolve() -> URL? {
        if let bookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: bookmark,
                                  options: [.withSecurityScope],
                                  relativeTo: nil,
                                  bookmarkDataIsStale: &stale) {
                return url
            }
        }
        let url = URL(fileURLWithPath: path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

/// How a source frame is fitted into the quad it is drawn into, when the
/// source's aspect ratio doesn't match.
///
/// This matters constantly in practice: the program canvas is 16:9 (or 9:16
/// for vertical), while a shared window might be 4:3, a phone screen 19.5:9,
/// or a code editor almost square. Without an explicit choice the frame would
/// be stretched, which distorts faces and text.
enum SourceFit: String, Codable, CaseIterable, Sendable {
    /// Contain: the whole source is visible, centred, with empty space on the
    /// axis that doesn't reach the edges. The safe default.
    case fit
    /// Cover: fills the canvas, cropping whatever overflows.
    case fill
    /// Contain in front, plus a blurred, zoomed copy of the same source behind
    /// it filling the empty space — no hard bars.
    case blurredBackdrop
    /// Ignore aspect and stretch to the quad. Rarely what you want; kept as an
    /// escape hatch (and it is what the compositor did before fits existed).
    case stretch

    var displayName: String {
        switch self {
        case .fit: "Fit (centred)"
        case .fill: "Fill (crop)"
        case .blurredBackdrop: "Fit + blurred background"
        case .stretch: "Stretch"
        }
    }

    var help: String {
        switch self {
        case .fit: "Show all of it, centred. Empty space where the shape doesn't match."
        case .fill: "Fill the frame and crop the overflow."
        case .blurredBackdrop: "Centred, with a blurred copy behind filling the sides."
        case .stretch: "Distort to fill the frame exactly."
        }
    }
}

/// How a source is framed inside its quad: the fit rule plus a manual
/// zoom/pan on top of it, so a small shared window can be pushed in to fill
/// more of the frame.
struct SourcePresentation: Codable, Hashable, Sendable {
    var fit: SourceFit
    /// 1 = the fit rule as-is; >1 zooms in (and crops); <1 pulls back.
    var zoom: Double
    /// Pan within the source, in units of the *sampled window* (±0.5 walks to
    /// the edges). Only has an effect where content is cropped.
    var pan: CGPoint
    /// Backdrop blur strength for `.blurredBackdrop`, 0…1.
    var backdropBlur: Double
    /// How far the backdrop is zoomed past "cover", so its edges aren't
    /// recognisable behind the sharp copy.
    var backdropZoom: Double

    init(fit: SourceFit = .fit,
         zoom: Double = 1,
         pan: CGPoint = .zero,
         backdropBlur: Double = 0.65,
         backdropZoom: Double = 1.15) {
        self.fit = fit
        self.zoom = zoom
        self.pan = pan
        self.backdropBlur = backdropBlur
        self.backdropZoom = backdropZoom
    }

    static let `default` = SourcePresentation()

    /// What a LIVE CAMERA should do: cover the canvas. A camera framing is
    /// the shot itself — letterboxing it (which `.fit` does the moment the
    /// program isn't the camera's aspect, e.g. a square or vertical show)
    /// is never what anyone wants. Shared screens keep `.fit`, where losing
    /// edges would cut off content.
    static let camera = SourcePresentation(fit: .fill)

    /// Clamped to ranges the shader can handle sensibly.
    var sanitized: SourcePresentation {
        var copy = self
        copy.zoom = min(max(zoom, 0.2), 8)
        copy.pan = CGPoint(x: min(max(pan.x, -1), 1), y: min(max(pan.y, -1), 1))
        copy.backdropBlur = min(max(backdropBlur, 0), 1)
        copy.backdropZoom = min(max(backdropZoom, 1), 3)
        return copy
    }
}

/// Which camera: the system default, or a specific device by unique id.
///
/// This used to be spelled two ways — `SourceKey.camera` used `nil` for the
/// default while `SourceBinding.camera` used `""` — with the translation
/// copy-pasted at three sites. One type, one spelling, zero translations.
///
/// Encodes as the bare uid string ("" for the default), which is exactly what
/// documents already store, so existing projects decode unchanged.
struct CameraID: Codable, Hashable, Sendable, CustomStringConvertible {
    /// "" means the system default — private so no call site can re-invent
    /// the sentinel; go through `uid` / `isSystemDefault`.
    private let rawUID: String

    static let systemDefault = CameraID(uid: nil)

    /// `nil` (or empty) = system default.
    init(uid: String?) {
        self.rawUID = uid ?? ""
    }

    /// The device unique id, or nil for the system default — the shape
    /// `CameraSource.device(uniqueID:)` takes.
    var uid: String? { rawUID.isEmpty ? nil : rawUID }
    var isSystemDefault: Bool { rawUID.isEmpty }

    /// Stable identity component for transition keys and picker tags.
    var description: String { rawUID.isEmpty ? "default" : rawUID }

    init(from decoder: Decoder) throws {
        rawUID = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawUID)
    }
}

/// Which live source an element (or scene primary) is bound to.
enum SourceBinding: Codable, Hashable, Sendable {
    // The label stays `deviceUniqueID` — it is the persisted JSON key.
    case camera(deviceUniqueID: CameraID)
    case display(displayID: UInt32)
    case window(windowID: UInt32)
    /// A remote guest, keyed by LiveKit participant identity.
    case guest(identity: String)
    /// A remote guest's shared screen — independent of their camera tile.
    case guestScreen(identity: String)
}
