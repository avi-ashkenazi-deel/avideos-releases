import Foundation
import CoreGraphics

/// The studio document: everything a show setup is, minus runtime state.
/// Runtime (source states, animation clocks, selection) lives in
/// `SceneRuntime` / `StudioController` and is never persisted here.
struct Project: Codable, Hashable, Sendable, Identifiable {
    var schemaVersion: Int
    var id: UUID
    var name: String
    /// Program canvas in pixels. 1080p default: virtual-camera consumers cap
    /// around 1080p; podcast-mode 4K masters are recorded separately.
    var canvasSize: CGSize
    var frameRate: Int
    var scenes: [SceneModel]
    var activeSceneID: UUID?
    /// Default transition when a scene doesn't override.
    var defaultTransitionDuration: TimeInterval

    init(id: UUID = UUID(),
         name: String = "Untitled Show",
         canvasSize: CGSize = CGSize(width: 1920, height: 1080),
         frameRate: Int = 30,
         scenes: [SceneModel] = [],
         activeSceneID: UUID? = nil,
         defaultTransitionDuration: TimeInterval = 0.5) {
        self.schemaVersion = ModelSchema.version
        self.id = id
        self.name = name
        self.canvasSize = canvasSize
        self.frameRate = frameRate
        self.scenes = scenes
        self.activeSceneID = activeSceneID
        self.defaultTransitionDuration = defaultTransitionDuration
    }

    var activeScene: SceneModel? {
        scenes.first { $0.id == activeSceneID } ?? scenes.first
    }

    /// A sensible starter project: one of each scene kind.
    static func starter() -> Project {
        let camera = SceneModel(name: "Camera", kind: .camera(CameraSceneConfig()))
        let screen = SceneModel(name: "Screen Share", kind: .screenShare(ScreenSceneConfig()))
        let movie = SceneModel(name: "Movie", kind: .movie(MovieSceneConfig()))
        let interview = SceneModel(name: "Interview", kind: .interview(InterviewSceneConfig()))
        var project = Project(scenes: [camera, screen, movie, interview])
        project.activeSceneID = camera.id
        return project
    }
}
