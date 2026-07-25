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

    init(center: CGPoint = CGPoint(x: 0.5, y: 0.5),
         size: CGSize = CGSize(width: 0.4, height: 0.3),
         rotation: Double = 0,
         opacity: Double = 1) {
        self.center = center
        self.size = size
        self.rotation = rotation
        self.opacity = opacity
    }

    static let fullCanvas = ElementTransform(
        center: CGPoint(x: 0.5, y: 0.5),
        size: CGSize(width: 1, height: 1)
    )

    /// Linear interpolation, used by entry/exit animation evaluation and the
    /// scene-transition engine ("magic move").
    static func lerp(_ a: ElementTransform, _ b: ElementTransform, _ t: Double) -> ElementTransform {
        let t = min(max(t, 0), 1)
        return ElementTransform(
            center: CGPoint(x: a.center.x + (b.center.x - a.center.x) * t,
                            y: a.center.y + (b.center.y - a.center.y) * t),
            size: CGSize(width: a.size.width + (b.size.width - a.size.width) * t,
                         height: a.size.height + (b.size.height - a.size.height) * t),
            rotation: a.rotation + (b.rotation - a.rotation) * t,
            opacity: a.opacity + (b.opacity - a.opacity) * t
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

/// Which live source an element (or scene primary) is bound to.
enum SourceBinding: Codable, Hashable, Sendable {
    case camera(deviceUniqueID: String)
    case display(displayID: UInt32)
    case window(windowID: UInt32)
    /// A remote guest, keyed by LiveKit participant identity.
    case guest(identity: String)
}
