import Foundation
import CoreGraphics

/// A scene is the leading concept of the studio: what's on the program output
/// right now. Three primary kinds plus the interview layout for guests.
struct SceneModel: Codable, Hashable, Sendable, Identifiable {
    var id: UUID
    var name: String
    var kind: SceneKind
    /// Camera-filter chain applied to the scene's primary source (the camera
    /// feed, the shared screen, or the movie) before overlays composite.
    var primaryEffects: EffectChain
    /// Overlay layers, bottom → top.
    var elements: [Element]
    /// How switching *to* this scene animates.
    var transitionStyle: SceneTransitionStyle
    /// How the primary source is framed when its shape doesn't match the
    /// canvas — the common case for shared windows and portrait captures.
    var primaryPresentation: SourcePresentation

    init(id: UUID = UUID(),
         name: String,
         kind: SceneKind,
         primaryEffects: EffectChain = EffectChain(),
         elements: [Element] = [],
         transitionStyle: SceneTransitionStyle = .magicMove,
         primaryPresentation: SourcePresentation = .default) {
        self.id = id
        self.name = name
        self.kind = kind
        self.primaryEffects = primaryEffects
        self.elements = elements
        self.transitionStyle = transitionStyle
        self.primaryPresentation = primaryPresentation
    }

    /// Older documents predate framing, so a missing key decodes as the
    /// default fit rather than failing the whole project load.
    enum CodingKeys: String, CodingKey {
        case id, name, kind, primaryEffects, elements, transitionStyle, primaryPresentation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(UUID.self, forKey: .id)
        self.name = try container.decode(String.self, forKey: .name)
        self.kind = try container.decode(SceneKind.self, forKey: .kind)
        self.primaryEffects = try container.decodeIfPresent(EffectChain.self, forKey: .primaryEffects)
            ?? EffectChain()
        self.elements = try container.decodeIfPresent([Element].self, forKey: .elements) ?? []
        self.transitionStyle = try container.decodeIfPresent(SceneTransitionStyle.self,
                                                            forKey: .transitionStyle) ?? .magicMove
        self.primaryPresentation = try container.decodeIfPresent(SourcePresentation.self,
                                                                 forKey: .primaryPresentation)
            ?? .default
    }
}

enum SceneKind: Codable, Hashable, Sendable {
    case camera(CameraSceneConfig)
    case screenShare(ScreenSceneConfig)
    case movie(MovieSceneConfig)
    case interview(InterviewSceneConfig)

    var displayName: String {
        switch self {
        case .camera: "Camera"
        case .screenShare: "Screen Share"
        case .movie: "Movie"
        case .interview: "Interview"
        }
    }
}

struct CameraSceneConfig: Codable, Hashable, Sendable {
    /// AVCaptureDevice.uniqueID; nil = system default camera.
    var deviceUniqueID: String?

    init(deviceUniqueID: String? = nil) {
        self.deviceUniqueID = deviceUniqueID
    }
}

struct ScreenSceneConfig: Codable, Hashable, Sendable {
    enum Target: Codable, Hashable, Sendable {
        case display(displayID: UInt32)
        case window(windowID: UInt32, appName: String)
        /// Let the macOS 14 content-sharing picker choose at go-time.
        case askEachTime
    }

    var target: Target
    var showsCursor: Bool

    init(target: Target = .askEachTime, showsCursor: Bool = true) {
        self.target = target
        self.showsCursor = showsCursor
    }
}

struct MovieSceneConfig: Codable, Hashable, Sendable {
    var media: MediaReference?
    var loops: Bool
    /// Movie audio routes into the mixer as its own strip.
    var volume: Double

    init(media: MediaReference? = nil, loops: Bool = false, volume: Double = 1) {
        self.media = media
        self.loops = loops
        self.volume = volume
    }
}

struct InterviewSceneConfig: Codable, Hashable, Sendable {
    enum GridStyle: String, Codable, CaseIterable, Sendable {
        /// Even grid sized to participant count (1×2, 2×2…).
        case grid
        /// Host large, guests in a side column.
        case hostLeading
        /// One large active area + filmstrip (layout follows active speaker).
        case spotlight

        var displayName: String {
            switch self {
            case .grid: "Grid"
            case .hostLeading: "Host Leading"
            case .spotlight: "Spotlight"
            }
        }
    }

    var gridStyle: GridStyle
    /// Include the host's own camera as a tile.
    var includesHost: Bool
    var hostDeviceUniqueID: String?
    /// Unit gap between tiles.
    var tileSpacing: Double
    var tileCornerRadius: Double

    init(gridStyle: GridStyle = .grid,
         includesHost: Bool = true,
         hostDeviceUniqueID: String? = nil,
         tileSpacing: Double = 0.015,
         tileCornerRadius: Double = 0.015) {
        self.gridStyle = gridStyle
        self.includesHost = includesHost
        self.hostDeviceUniqueID = hostDeviceUniqueID
        self.tileSpacing = tileSpacing
        self.tileCornerRadius = tileCornerRadius
    }
}

/// How the program animates when switching TO a scene.
enum SceneTransitionStyle: String, Codable, CaseIterable, Sendable {
    case cut
    case dissolve
    /// Diff the two scenes' render plans and glide matched elements to their
    /// new spots; unmatched elements play exit/entry animations.
    case magicMove

    var displayName: String {
        switch self {
        case .cut: "Cut"
        case .dissolve: "Dissolve"
        case .magicMove: "Magic Move"
        }
    }
}
