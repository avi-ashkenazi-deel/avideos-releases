import Foundation
import CoreGraphics
import CoreMedia

/// An immutable, render-thread-consumable snapshot of "what to draw".
///
/// The main actor compiles a new plan whenever the document or runtime state
/// changes (element toggled, scene switched, slider dragged) and publishes it
/// atomically; the render loop reads the latest plan each tick and evaluates
/// the *time-dependent* parts (entry/exit animation progress, shader-fill
/// clocks, transitions) against the frame timestamp. No locks are held during
/// a render pass.
struct RenderPlan: Sendable {
    var canvasSize: CGSize
    /// Bottom → top.
    var items: [RenderItem]
    /// Scene background when the primary source has no frame yet.
    var backgroundColor: RGBAColor

    static let empty = RenderPlan(canvasSize: CGSize(width: 1920, height: 1080),
                                  items: [],
                                  backgroundColor: .black)
}

/// One drawable layer, fully resolved from the document.
struct RenderItem: Sendable, Identifiable {
    var id: UUID
    /// Matching key for magic-move transitions (see `Element.transitionKey`).
    var transitionKey: String
    var content: RenderContent
    /// The element's resting transform (before animation).
    var transform: ElementTransform
    var blendMode: BlendMode
    var effects: EffectChain
    var stroke: Stroke?
    /// Corner radius in unit terms (rounded shapes, source tiles).
    var cornerRadius: Double
    var entryAnimation: EntryAnimation
    /// Where this item is in its show/hide lifecycle at plan-compile time.
    var animation: AnimationState
}

/// What fills the item's quad.
enum RenderContent: Sendable {
    /// A live frame source (camera / screen / movie / web / guest / image /
    /// video-fill), keyed into the `SourceRegistry`.
    case source(sourceKey: SourceKey)
    /// Procedural or solid paint.
    case fill(Fill)
    /// Rasterized text (cache-keyed by the spec's hash).
    case text(TextContent, color: Fill)
}

/// Stable identity for a live source across plan rebuilds.
/// The registry owns the actual `FrameSource` instances.
enum SourceKey: Hashable, Sendable, CustomStringConvertible {
    case camera(deviceUniqueID: String?)
    case display(displayID: UInt32)
    case window(windowID: UInt32)
    case movie(elementID: UUID)
    case web(elementID: UUID)
    case image(elementID: UUID)
    case guest(identity: String)
    case fillVideo(elementID: UUID)
    /// Scene-level primary sources use the scene ID.
    case scenePrimary(sceneID: UUID)

    var description: String {
        switch self {
        case .camera(let id): "camera:\(id ?? "default")"
        case .display(let id): "display:\(id)"
        case .window(let id): "window:\(id)"
        case .movie(let id): "movie:\(id)"
        case .web(let id): "web:\(id)"
        case .image(let id): "image:\(id)"
        case .guest(let id): "guest:\(id)"
        case .fillVideo(let id): "fillVideo:\(id)"
        case .scenePrimary(let id): "scene:\(id)"
        }
    }
}

/// Entry/exit lifecycle, evaluated against the frame clock on the render
/// thread. Host times are seconds on the host clock (`CMTime.seconds`).
enum AnimationState: Sendable {
    /// Fully shown, no animation running.
    case resting
    /// Playing the entry animation since `startSeconds`.
    case entering(startSeconds: Double)
    /// Playing exit (reversed entry) since `startSeconds`; the item leaves
    /// the plan once the exit completes (the compiler drops it next rebuild).
    case exiting(startSeconds: Double)

    /// Progress (0 out … 1 in) at `now`, or nil when the exit has finished
    /// and the item should not draw at all.
    func progress(at now: Double, duration: TimeInterval) -> Double? {
        guard duration > 0 else { return 1 }
        switch self {
        case .resting:
            return 1
        case .entering(let start):
            return min(1, max(0, (now - start) / duration))
        case .exiting(let start):
            let p = 1 - (now - start) / duration
            return p <= 0 ? nil : min(1, p)
        }
    }
}

// MARK: - Plan compilation

enum RenderPlanCompiler {
    /// Compiles the active scene into a plan. `elementAnimations` carries the
    /// runtime show/hide state keyed by element ID (managed by SceneRuntime);
    /// elements absent from the map are `.resting`.
    static func compile(project: Project,
                        scene: SceneModel,
                        guests: [GuestDescriptor],
                        elementAnimations: [UUID: AnimationState]) -> RenderPlan {
        var items: [RenderItem] = []

        // 1. The scene's primary content fills the canvas underneath overlays.
        items.append(contentsOf: primaryItems(for: scene, guests: guests))

        // 2. Overlay elements, bottom → top.
        for element in scene.elements {
            let state = elementAnimations[element.id]
            // Invisible elements only draw while their exit animation runs.
            if !element.isVisible {
                guard case .exiting = state else { continue }
            }
            items.append(item(for: element, state: state ?? .resting))
        }

        return RenderPlan(canvasSize: project.canvasSize,
                          items: items,
                          backgroundColor: .black)
    }

    private static func item(for element: Element, state: AnimationState) -> RenderItem {
        let content: RenderContent
        var cornerRadius = 0.0

        switch element.kind {
        case .text(let text):
            content = .text(text, color: element.fill ?? .solid(.white))
        case .shape(let shape):
            content = .fill(element.fill ?? .solid(.white))
            if shape.shape == .roundedRectangle { cornerRadius = shape.cornerRadius }
            if shape.shape == .ellipse { cornerRadius = -1 } // sentinel: ellipse mask
        case .image:
            content = .source(sourceKey: .image(elementID: element.id))
        case .video:
            content = .source(sourceKey: .movie(elementID: element.id))
        case .web:
            content = .source(sourceKey: .web(elementID: element.id))
        case .source(let binding):
            content = .source(sourceKey: sourceKey(for: binding))
            cornerRadius = 0.01
        }

        return RenderItem(id: element.id,
                          transitionKey: element.transitionKey,
                          content: content,
                          transform: element.transform,
                          blendMode: element.blendMode,
                          effects: element.effects,
                          stroke: element.stroke,
                          cornerRadius: cornerRadius,
                          entryAnimation: element.entryAnimation,
                          animation: state)
    }

    private static func sourceKey(for binding: SourceBinding) -> SourceKey {
        switch binding {
        case .camera(let uid): .camera(deviceUniqueID: uid)
        case .display(let id): .display(displayID: id)
        case .window(let id): .window(windowID: id)
        case .guest(let identity): .guest(identity: identity)
        }
    }

    /// The scene's primary content: one full-canvas item for camera/screen/
    /// movie scenes; a computed tile layout for interview scenes.
    private static func primaryItems(for scene: SceneModel,
                                     guests: [GuestDescriptor]) -> [RenderItem] {
        switch scene.kind {
        case .camera(let config):
            return [primaryItem(scene: scene,
                                key: .camera(deviceUniqueID: config.deviceUniqueID),
                                transform: .fullCanvas)]
        case .screenShare(let config):
            let key: SourceKey
            switch config.target {
            case .display(let id): key = .display(displayID: id)
            case .window(let id, _): key = .window(windowID: id)
            case .askEachTime: key = .scenePrimary(sceneID: scene.id)
            }
            return [primaryItem(scene: scene, key: key, transform: .fullCanvas)]
        case .movie:
            return [primaryItem(scene: scene,
                                key: .scenePrimary(sceneID: scene.id),
                                transform: .fullCanvas)]
        case .interview(let config):
            return interviewItems(scene: scene, config: config, guests: guests)
        }
    }

    private static func primaryItem(scene: SceneModel,
                                    key: SourceKey,
                                    transform: ElementTransform,
                                    cornerRadius: Double = 0,
                                    transitionKeySuffix: String = "") -> RenderItem {
        RenderItem(id: scene.id,
                   transitionKey: "primary:\(key)\(transitionKeySuffix)",
                   content: .source(sourceKey: key),
                   transform: transform,
                   blendMode: .normal,
                   effects: scene.primaryEffects,
                   stroke: nil,
                   cornerRadius: cornerRadius,
                   entryAnimation: EntryAnimation(style: .fade),
                   animation: .resting)
    }

    /// Interview layout: host + guests arranged per grid style. Tiles use
    /// source-based transition keys, so magic-move glides the same person
    /// between layouts and scenes.
    private static func interviewItems(scene: SceneModel,
                                       config: InterviewSceneConfig,
                                       guests: [GuestDescriptor]) -> [RenderItem] {
        var tiles: [(key: SourceKey, transitionKey: String)] = []
        if config.includesHost {
            let key = SourceKey.camera(deviceUniqueID: config.hostDeviceUniqueID)
            tiles.append((key, "camera:\(config.hostDeviceUniqueID ?? "default")"))
        }
        for guest in guests {
            tiles.append((.guest(identity: guest.identity), "guest:\(guest.identity)"))
        }
        guard !tiles.isEmpty else { return [] }

        let frames = InterviewLayout.frames(count: tiles.count,
                                            style: config.gridStyle,
                                            spacing: config.tileSpacing)
        return zip(tiles, frames).map { tile, frame in
            var item = primaryItem(scene: scene,
                                   key: tile.key,
                                   transform: frame,
                                   cornerRadius: config.tileCornerRadius)
            item.transitionKey = tile.transitionKey
            return item
        }
    }
}

/// A connected guest, as the compiler needs to see it.
struct GuestDescriptor: Sendable, Hashable {
    var identity: String
    var displayName: String
}

/// Pure layout math for interview grids — unit-coordinate tile frames.
enum InterviewLayout {
    static func frames(count: Int,
                       style: InterviewSceneConfig.GridStyle,
                       spacing: Double) -> [ElementTransform] {
        guard count > 0 else { return [] }
        switch style {
        case .grid:
            return gridFrames(count: count, spacing: spacing)
        case .hostLeading:
            return hostLeadingFrames(count: count, spacing: spacing)
        case .spotlight:
            return spotlightFrames(count: count, spacing: spacing)
        }
    }

    private static func gridFrames(count: Int, spacing: Double) -> [ElementTransform] {
        let columns = Int(ceil(sqrt(Double(count))))
        let rows = Int(ceil(Double(count) / Double(columns)))
        let cellW = (1.0 - spacing * Double(columns + 1)) / Double(columns)
        let cellH = (1.0 - spacing * Double(rows + 1)) / Double(rows)
        return (0..<count).map { i in
            let col = i % columns
            let row = i / columns
            // Center the last (possibly short) row.
            let itemsInRow = row == rows - 1 ? count - row * columns : columns
            let rowWidth = Double(itemsInRow) * cellW + Double(itemsInRow - 1) * spacing
            let xStart = (1.0 - rowWidth) / 2
            let x = xStart + Double(col) * (cellW + spacing) + cellW / 2
            let y = spacing + Double(row) * (cellH + spacing) + cellH / 2
            return ElementTransform(center: CGPoint(x: x, y: y),
                                    size: CGSize(width: cellW, height: cellH))
        }
    }

    private static func hostLeadingFrames(count: Int, spacing: Double) -> [ElementTransform] {
        guard count > 1 else { return [.fullCanvas] }
        let hostW = 0.62
        let guestW = 1.0 - hostW - spacing * 3
        let guestCount = count - 1
        let guestH = (1.0 - spacing * Double(guestCount + 1)) / Double(guestCount)
        var frames = [ElementTransform(center: CGPoint(x: spacing + hostW / 2, y: 0.5),
                                       size: CGSize(width: hostW, height: 1.0 - spacing * 2))]
        for i in 0..<guestCount {
            let y = spacing + Double(i) * (guestH + spacing) + guestH / 2
            frames.append(ElementTransform(center: CGPoint(x: 1.0 - spacing - guestW / 2, y: y),
                                           size: CGSize(width: guestW, height: guestH)))
        }
        return frames
    }

    private static func spotlightFrames(count: Int, spacing: Double) -> [ElementTransform] {
        guard count > 1 else { return [.fullCanvas] }
        let stripH = 0.2
        let mainH = 1.0 - stripH - spacing * 3
        var frames = [ElementTransform(center: CGPoint(x: 0.5, y: spacing + mainH / 2),
                                       size: CGSize(width: 1.0 - spacing * 2, height: mainH))]
        let stripCount = count - 1
        let tileW = min(0.22, (1.0 - spacing * Double(stripCount + 1)) / Double(stripCount))
        let totalW = Double(stripCount) * tileW + Double(stripCount - 1) * spacing
        let xStart = (1.0 - totalW) / 2
        for i in 0..<stripCount {
            let x = xStart + Double(i) * (tileW + spacing) + tileW / 2
            frames.append(ElementTransform(center: CGPoint(x: x, y: 1.0 - spacing - stripH / 2),
                                           size: CGSize(width: tileW, height: stripH)))
        }
        return frames
    }
}
