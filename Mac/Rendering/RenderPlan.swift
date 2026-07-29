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
    /// How source content is fitted into this item's quad. Only meaningful for
    /// `.source` content; `.default` (fit) for everything else.
    var presentation: SourcePresentation = .default
    /// Set on the blurred backdrop item that sits behind a
    /// `.blurredBackdrop` primary, so the compositor knows to blur it.
    var isBackdrop: Bool = false
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
    /// `timerTexts` carries the current countdown string per timer element —
    /// runtime state the document doesn't hold (StudioController ticks it).
    static func compile(project: Project,
                        scene: SceneModel,
                        guests: [GuestDescriptor],
                        elementAnimations: [UUID: AnimationState],
                        timerTexts: [UUID: String] = [:]) -> RenderPlan {
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
            items.append(contentsOf: items(for: element,
                                           state: state ?? .resting,
                                           timerTexts: timerTexts))
        }

        return RenderPlan(canvasSize: project.canvasSize,
                          items: items,
                          backgroundColor: .black)
    }

    /// One element usually compiles to one item; a boxed text compiles to a
    /// background shape item plus the glyph item on top (same transform, same
    /// animation, so they move as one).
    private static func items(for element: Element,
                              state: AnimationState,
                              timerTexts: [UUID: String]) -> [RenderItem] {
        let content: RenderContent
        var cornerRadius = 0.0
        var background: RenderItem?

        switch element.kind {
        case .text(let text):
            content = .text(text, color: element.fill ?? .solid(.white))
            if let boxFill = text.boxFill {
                background = boxItem(for: element,
                                     fill: boxFill,
                                     cornerRadius: text.boxCornerRadius ?? 0.04,
                                     state: state)
            }
        case .timer(let timer):
            // A countdown is text whose string the studio ticks per second.
            let string = timerTexts[element.id] ?? TimerContent.formatted(timer.durationSeconds)
            let text = TextContent(string: string,
                                   fontName: timer.fontName,
                                   fontSize: timer.fontSize,
                                   alignment: .center)
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
            cornerRadius = element.tileShape?.cornerRadius ?? 0.01
        }

        var item = RenderItem(id: element.id,
                              transitionKey: element.transitionKey,
                              content: content,
                              transform: element.transform,
                              blendMode: element.blendMode,
                              effects: element.effects,
                              // A boxed text's stroke borders the BOX, not the
                              // glyph quad.
                              stroke: background == nil ? element.stroke : nil,
                              cornerRadius: cornerRadius,
                              entryAnimation: element.entryAnimation,
                              animation: state)
        // A PiP tile covers its frame (a circle mask over letterboxing reads
        // as a bug); scene primaries manage their own framing elsewhere.
        if case .source = element.kind {
            item.presentation.fit = .fill
        }
        if let background {
            return [background, item]
        }
        return [item]
    }

    /// The text-box background: same footprint as the text item, painted with
    /// the box fill, carrying the element's stroke.
    private static func boxItem(for element: Element,
                                fill: Fill,
                                cornerRadius: Double,
                                state: AnimationState) -> RenderItem {
        RenderItem(id: textBoxID(for: element.id),
                   transitionKey: element.transitionKey + ":box",
                   content: .fill(fill),
                   transform: element.transform,
                   blendMode: element.blendMode,
                   effects: EffectChain(),
                   stroke: element.stroke,
                   cornerRadius: cornerRadius,
                   entryAnimation: element.entryAnimation,
                   animation: state)
    }

    /// Deterministic sibling id for a text element's box item — stable across
    /// recompiles, never equal to the element's own id (same trick as
    /// `backdropID`).
    static func textBoxID(for elementID: UUID) -> UUID {
        var bytes = elementID.uuid
        bytes.0 = bytes.0 ^ 0xFF
        return UUID(uuid: bytes)
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
            return framedPrimary(scene: scene,
                                 key: .camera(deviceUniqueID: config.deviceUniqueID))
        case .screenShare(let config):
            let key: SourceKey
            switch config.target {
            case .display(let id): key = .display(displayID: id)
            case .window(let id, _): key = .window(windowID: id)
            case .askEachTime: key = .scenePrimary(sceneID: scene.id)
            }
            return framedPrimary(scene: scene, key: key)
        case .movie:
            return framedPrimary(scene: scene, key: .scenePrimary(sceneID: scene.id))
        case .interview(let config):
            return interviewItems(scene: scene, config: config, guests: guests)
        }
    }

    /// One full-canvas primary item — or two, when the scene asks for a
    /// blurred backdrop: a cover-fitted blurred copy underneath, then the
    /// contained sharp copy on top. Expressing it as an extra item keeps the
    /// compositor free of special cases.
    private static func framedPrimary(scene: SceneModel, key: SourceKey) -> [RenderItem] {
        let presentation = scene.primaryPresentation.sanitized

        guard presentation.fit == .blurredBackdrop else {
            var item = primaryItem(scene: scene, key: key, transform: .fullCanvas)
            item.presentation = presentation
            return [item]
        }

        var backdrop = primaryItem(scene: scene,
                                   key: key,
                                   transform: .fullCanvas,
                                   transitionKeySuffix: ":backdrop")
        // A distinct id so the two items never collide in transition matching
        // or in the effects cache.
        backdrop.id = Self.backdropID(for: scene.id)
        backdrop.isBackdrop = true
        // The backdrop covers, zoomed a little past the edges, and ignores the
        // foreground's manual zoom/pan so it stays a calm background.
        var backdropPresentation = presentation
        backdropPresentation.fit = .fill
        backdropPresentation.zoom = presentation.backdropZoom
        backdropPresentation.pan = .zero
        backdrop.presentation = backdropPresentation
        // Effects are applied once, on the sharp copy; the backdrop is a plain
        // blurred frame so a chroma key doesn't punch holes in it.
        backdrop.effects = EffectChain()

        var foreground = primaryItem(scene: scene, key: key, transform: .fullCanvas)
        var foregroundPresentation = presentation
        foregroundPresentation.fit = .fit
        foreground.presentation = foregroundPresentation

        return [backdrop, foreground]
    }

    /// Deterministic id for a scene's backdrop item, derived from the scene id
    /// so it is stable across recompiles (animation state is keyed by item id).
    static func backdropID(for sceneID: UUID) -> UUID {
        var bytes = sceneID.uuid
        // Flip the last byte; UUID equality is byte equality, and a scene can
        // never legitimately own this value as its own id.
        bytes.15 = bytes.15 ^ 0xFF
        return UUID(uuid: bytes)
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
