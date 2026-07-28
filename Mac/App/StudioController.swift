import Foundation
import AppKit
import AVFoundation
import CoreMedia
import CoreVideo
import ImageIO
import Metal
import Observation
import os

/// The app's live-mode hub: owns every subsystem, compiles render plans from
/// the document + runtime state, and wires the cross-subsystem plumbing
/// (camera taps → segmentation + podcast recorder, program frames → virtual
/// camera + recorder, guests → mixer + compositor, data channel → podcast +
/// teleprompter).
@MainActor
@Observable
final class StudioController {
    enum Mode {
        case live
        case edit(EditProject)
    }

    // MARK: - Subsystems

    let renderEngine: RenderEngine?
    let sourceRegistry: SourceRegistry?
    let virtualCamera = VirtualCameraController()
    let recorder = ProgramRecorder()
    let audio = AudioEngineController()
    let midi = MIDIController()
    let teleprompter: TeleprompterController
    let podcast: RecordingSessionController
    let guests: GuestSessionController?
    let sessionLibrary = SessionLibraryStore()

    // MARK: - Document + runtime state

    var project: Project {
        didSet {
            ProjectStore.shared.saveDebounced(project)
            recompileAndPublish()
        }
    }
    /// Entry/exit animation lifecycle per element.
    private var elementAnimations: [UUID: AnimationState] = [:]
    var selectedElementID: UUID?
    var mode: Mode = .live

    /// Worker/base configuration (Settings).
    var workerBaseURL: URL? {
        get { UserDefaults.standard.url(forKey: "workerBaseURL") }
        set { UserDefaults.standard.set(newValue, forKey: "workerBaseURL") }
    }

    private(set) var isLive = false
    /// Observable mirror of the recorder's state. ProgramRecorder is a plain
    /// class — computing this from `recorder.state` compiled fine but SwiftUI
    /// never saw changes, so the Record button gave no feedback at all and
    /// recording looked broken.
    private(set) var isRecording = false

    /// The finished take, driving the "what now" dialog (delete / show in
    /// Finder / open in editor) after every stop.
    var lastRecordingURL: URL?
    var showingRecordingOptions = false

    /// Latest program frame for the preview MTKView.
    let previewStore = PreviewFrameStore()

    private let virtualCameraConsumer: VirtualCameraFrameConsumer
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "studio")

    // MARK: - Init & wiring

    init() {
        let engine = RenderEngine()
        self.renderEngine = engine
        let registry = engine.map { SourceRegistry(device: $0.device) }
        self.sourceRegistry = registry
        self.project = ProjectStore.shared.loadMostRecentOrStarter()
        self.teleprompter = TeleprompterController()
        self.podcast = RecordingSessionController()
        self.guests = engine.map { GuestSessionController(metalDevice: $0.device) }
        self.virtualCameraConsumer = VirtualCameraFrameConsumer(writer: virtualCamera.sinkWriter)

        wireSubsystems()
    }

    /// Whether `bootSubsystems()` has run.
    private var hasBooted = false

    /// Starts everything that talks to the outside world: the render clock,
    /// the camera (via the first plan compile), the audio engines, CoreMIDI,
    /// the CMIO sink, and the teleprompter's event monitors.
    ///
    /// Deliberately NOT part of `init`. This controller is created as a
    /// SwiftUI `@State` default value, which runs when the App struct is built
    /// — before `NSApplicationMain`, before AppKit registers the process as a
    /// GUI application. Starting capture and media-daemon connections that
    /// early races AppKit for the process's window-server registration; when
    /// the wrong side wins, the app launches in a half-registered state where
    /// windows draw but activation is refused — clicks, menus and key
    /// equivalents all dead, and only on some launches. First observed on the
    /// app's first real Mac bring-up; the fix is simply to ignite after
    /// launch, from `onAppear`.
    func bootSubsystems() {
        guard !hasBooted else { return }
        hasBooted = true
        teleprompter.installKeyMonitorsIfNeeded()
        renderEngine?.start(canvasSize: project.canvasSize, fps: project.frameRate)
        recompileAndPublish()
        audio.start()
        // After audio, since every MIDI action lands on the audio facade.
        midi.start(audio: audio)
        virtualCamera.connectSinkIfNeeded()
    }

    private func wireSubsystems() {
        guard let engine = renderEngine, let registry = sourceRegistry else { return }

        // Compositor pulls source textures from the registry.
        engine.sourceTextureProvider = { [weak registry] key, time in
            registry?.texture(for: key, at: time)
        }

        // Program frames fan out to preview + virtual camera (recorder joins
        // while recording).
        engine.addConsumer(previewStore)
        engine.addConsumer(virtualCameraConsumer)

        // Camera frames feed segmentation (virtual background/beautify) and
        // the podcast host recorder.
        registry.cameraFrameTap = { [weak self] sampleBuffer in
            guard let self else { return }
            if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
                self.renderEngine?.compositor.effectRenderer.segmentation.submit(pixelBuffer: pixelBuffer)
            }
            self.podcast.hostRecorder?.ingestVideo(sampleBuffer)
        }

        // Media resolution for movie/image/web/fill-video sources.
        registry.mediaResolver = { [weak self] key in
            self?.resolveMedia(for: key)
        }
        registry.webContentResolver = { [weak self] key in
            guard case .web(let elementID) = key else { return nil }
            return self?.findElement(id: elementID).flatMap {
                if case .web(let content) = $0.kind { return content }
                return nil
            }
        }

        // Mic raw buffers → podcast host recorder.
        audio.micCapture.rawBufferTap = { [weak self] buffer, time in
            self?.podcast.hostRecorder?.ingestMic(buffer, time)
        }

        // Guests: sources into the registry, audio into mixer strips, data
        // channel multiplexed to podcast + teleprompter.
        guests?.registerSource = { [weak registry] source in registry?.register(source) }
        guests?.unregisterSource = { [weak registry] key in registry?.unregister(key: key) }
        guests?.attachGuestAudio = { [weak self] identity in self?.audio.attachGuest(identity: identity) }
        guests?.detachGuestAudio = { [weak self] identity in self?.audio.detachGuest(identity: identity) }
        guests?.onGuestsChanged = { [weak self] in self?.recompileAndPublish() }
        guests?.onDataMessage = { [weak self] json in
            self?.podcast.handleDataMessage(json)
            self?.teleprompter.handleDataMessage(json)
        }
        podcast.sendData = { [weak self] json in self?.guests?.sendData(json) }
        teleprompter.sendData = { [weak self] json in self?.guests?.sendData(json) }
    }

    func shutdown() {
        renderEngine?.stop()
        sourceRegistry?.stopAll()
        audio.shutdown()
        if recorder.isRecording {
            recorder.stop { _ in }
        }
        Task { await guests?.disconnect() }
    }

    // MARK: - Plan compilation

    var activeScene: SceneModel? { project.activeScene }

    /// Rebuilds the plan for the active scene and hands it to the renderer.
    func recompileAndPublish() {
        guard let engine = renderEngine, let scene = project.activeScene else { return }
        cleanupFinishedExits()
        let plan = RenderPlanCompiler.compile(project: project,
                                              scene: scene,
                                              guests: guests?.guestDescriptors ?? [],
                                              elementAnimations: elementAnimations)
        engine.publish(plan: plan)
        ensureScenePrimarySources(for: scene)
        sourceRegistry?.activate(keys: SourceRegistry.keys(in: plan))
    }

    /// Switches scenes with the configured transition (magic move by default).
    func switchScene(to sceneID: UUID) {
        guard sceneID != project.activeSceneID,
              let engine = renderEngine,
              let fromScene = project.activeScene,
              let toScene = project.scenes.first(where: { $0.id == sceneID }) else { return }

        let guestList = guests?.guestDescriptors ?? []
        let fromPlan = RenderPlanCompiler.compile(project: project, scene: fromScene,
                                                  guests: guestList,
                                                  elementAnimations: elementAnimations)
        elementAnimations.removeAll()
        var toProject = project
        toProject.activeSceneID = sceneID
        let toPlan = RenderPlanCompiler.compile(project: toProject, scene: toScene,
                                                guests: guestList,
                                                elementAnimations: [:])

        // Both scenes' sources must run through the transition window.
        ensureScenePrimarySources(for: toScene)
        let unionKeys = SourceRegistry.keys(in: fromPlan).union(SourceRegistry.keys(in: toPlan))
        sourceRegistry?.activate(keys: unionKeys)

        let duration = project.defaultTransitionDuration
        engine.beginTransition(from: fromPlan, to: toPlan,
                               style: toScene.transitionStyle,
                               duration: duration)
        project.activeSceneID = sceneID   // didSet republishes the resting plan
        teleprompter.sceneDidChange(sceneID: sceneID)

        // Reconcile sources after the transition ends (drop the old scene's).
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration + 0.1))
            self?.recompileAndPublish()
        }
    }

    /// Switches to the scene `offset` positions from the current one, wrapping
    /// at both ends. Drives the next/previous-scene global hotkeys, so a host
    /// can walk the rundown without leaving Zoom.
    func advanceScene(by offset: Int) {
        guard !project.scenes.isEmpty else { return }
        let currentIndex = project.activeSceneID
            .flatMap { id in project.scenes.firstIndex { $0.id == id } } ?? 0
        let count = project.scenes.count
        // Positive modulo: -1 from index 0 must land on the last scene.
        let nextIndex = ((currentIndex + offset) % count + count) % count
        guard nextIndex != currentIndex else { return }
        switchScene(to: project.scenes[nextIndex].id)
    }

    /// Switches to the Nth scene in the sidebar (1-based) — the ⌘1…⌘9 menu
    /// commands. No-op when there is no such scene.
    func switchToScene(number: Int) {
        guard number >= 1, number <= project.scenes.count else { return }
        switchScene(to: project.scenes[number - 1].id)
    }

    /// Movie scenes and picker-based screen scenes need concrete sources the
    /// registry can't fabricate from a key alone.
    private func ensureScenePrimarySources(for scene: SceneModel) {
        guard let registry = sourceRegistry, let engine = renderEngine else { return }
        let key = SourceKey.scenePrimary(sceneID: scene.id)
        switch scene.kind {
        case .movie(let config):
            guard registry.source(for: key) == nil,
                  let url = config.media?.resolve() else { return }
            let source = MovieSource(key: key, url: url, loops: config.loops,
                                     muted: true, metalDevice: engine.device)
            registry.register(source)
            if let player = source.avPlayer {
                audio.attachMoviePlayer(player)
            }
        case .screenShare(let config):
            guard registry.source(for: key) == nil, case .askEachTime = config.target else { return }
            // v1: default to the main display when no explicit target is set;
            // the system content-sharing picker lands with the picker UI work.
            let mainDisplay = CGMainDisplayID()
            let source = ScreenSource(key: key, target: .display(displayID: mainDisplay),
                                      framesPerSecond: project.frameRate,
                                      showsCursor: config.showsCursor,
                                      metalDevice: engine.device)
            registry.register(source)
        default:
            break
        }
    }

    private func resolveMedia(for key: SourceKey) -> URL? {
        switch key {
        case .movie(let elementID), .image(let elementID):
            guard let element = findElement(id: elementID) else { return nil }
            switch element.kind {
            case .video(let content): return content.media.resolve()
            case .image(let media): return media.resolve()
            default: return nil
            }
        case .fillVideo(let elementID):
            guard let element = findElement(id: elementID) else { return nil }
            if case .video(let media) = element.fill { return media.resolve() }
            if let stroke = element.stroke, case .video(let media) = stroke.fill { return media.resolve() }
            return nil
        default:
            return nil
        }
    }

    // MARK: - Element editing

    func findElement(id: UUID) -> Element? {
        project.activeScene?.elements.first { $0.id == id }
    }

    func updateElement(_ element: Element) {
        guard let sceneIndex = project.scenes.firstIndex(where: { $0.id == project.activeSceneID }),
              let elementIndex = project.scenes[sceneIndex].elements.firstIndex(where: { $0.id == element.id })
        else { return }
        project.scenes[sceneIndex].elements[elementIndex] = element
    }

    func addElement(_ element: Element) {
        guard let sceneIndex = project.scenes.firstIndex(where: { $0.id == project.activeSceneID }) else { return }
        project.scenes[sceneIndex].elements.append(element)
        selectedElementID = element.id
    }

    func removeElement(id: UUID) {
        guard let sceneIndex = project.scenes.firstIndex(where: { $0.id == project.activeSceneID }) else { return }
        project.scenes[sceneIndex].elements.removeAll { $0.id == id }
        elementAnimations.removeValue(forKey: id)
        if selectedElementID == id { selectedElementID = nil }
    }

    /// Reorders elements within the active scene (array order = z-order,
    /// later draws on top). List.onMove signature so the layers panel binds
    /// straight through.
    func moveElements(fromOffsets: IndexSet, toOffset: Int) {
        guard let sceneIndex = project.scenes.firstIndex(where: { $0.id == project.activeSceneID }) else { return }
        project.scenes[sceneIndex].elements.move(fromOffsets: fromOffsets, toOffset: toOffset)
    }

    // MARK: - Element factories (inspector add-bar + overlays palette)

    func addTextElement() {
        addElement(Element(name: "Text",
                           kind: .text(TextContent(string: "Your text")),
                           transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.8),
                                                       size: CGSize(width: 0.5, height: 0.12)),
                           fill: .solid(.white),
                           entryAnimation: .styled(.slideFromBottom)))
    }

    func addShapeElement() {
        addElement(Element(name: "Shape",
                           kind: .shape(ShapeContent(shape: .roundedRectangle)),
                           transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.82),
                                                       size: CGSize(width: 0.55, height: 0.16)),
                           fill: .shader(ShaderFill()),
                           entryAnimation: .styled(.slideFromLeft)))
    }

    func addImageElement(url: URL) {
        addElement(Element(name: url.lastPathComponent,
                           kind: .image(MediaReference(url: url)),
                           transform: mediaTransform(forPixelSize: Self.imagePixelSize(url: url)),
                           entryAnimation: .styled(.fade)))
    }

    func addVideoElement(url: URL) {
        // Natural size loads async; the element appears once probed so its
        // bounding box starts at the video's real shape, not a default square.
        Task { @MainActor in
            let pixelSize = await Self.videoPixelSize(url: url)
            addElement(Element(name: url.lastPathComponent,
                               kind: .video(VideoContent(media: MediaReference(url: url))),
                               transform: mediaTransform(forPixelSize: pixelSize),
                               entryAnimation: .styled(.fade)))
        }
    }

    func addWebElement() {
        addElement(Element(name: "Web Overlay",
                           kind: .web(WebContent(urlString: "https://example.com")),
                           transform: .fullCanvas,
                           entryAnimation: .styled(.fade)))
    }

    /// A camera PiP tile — the host small over a screen share, or a second
    /// angle. 16:9 tile in the lower-right, like an interview inset.
    func addCameraElement(deviceUniqueID: String, name: String) {
        addElement(Element(name: name,
                           kind: .source(.camera(deviceUniqueID: deviceUniqueID)),
                           transform: ElementTransform(center: CGPoint(x: 0.82, y: 0.76),
                                                       size: CGSize(width: 0.28, height: 0.28)),
                           entryAnimation: .styled(.fade)))
    }

    /// A guest tile as a freely placeable element (beyond the interview grid).
    func addGuestElement(identity: String, name: String) {
        addElement(Element(name: name,
                           kind: .source(.guest(identity: identity)),
                           transform: ElementTransform(center: CGPoint(x: 0.82, y: 0.76),
                                                       size: CGSize(width: 0.28, height: 0.28)),
                           entryAnimation: .styled(.fade)))
    }

    /// Element transform matching the media's real pixels: 1:1 with canvas
    /// pixels when it fits, scaled down at its own aspect when it doesn't.
    private func mediaTransform(forPixelSize pixelSize: CGSize?) -> ElementTransform {
        guard let pixelSize, pixelSize.width > 0, pixelSize.height > 0 else {
            return ElementTransform()
        }
        let canvas = project.canvasSize
        let scale = min(1, canvas.width / pixelSize.width, canvas.height / pixelSize.height)
        return ElementTransform(center: CGPoint(x: 0.5, y: 0.5),
                                size: CGSize(width: pixelSize.width * scale / canvas.width,
                                             height: pixelSize.height * scale / canvas.height))
    }

    private static func imagePixelSize(url: URL) -> CGSize? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Double,
              let height = properties[kCGImagePropertyPixelHeight] as? Double else { return nil }
        // EXIF orientations 5-8 are 90°-rotated; the displayed shape swaps.
        let orientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
        return orientation >= 5 ? CGSize(width: height, height: width)
                                : CGSize(width: width, height: height)
    }

    private static func videoPixelSize(url: URL) async -> CGSize? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (size, transform) = try? await track.load(.naturalSize, .preferredTransform)
        else { return nil }
        let rect = CGRect(origin: .zero, size: size).applying(transform)
        return CGSize(width: abs(rect.width), height: abs(rect.height))
    }

    /// Show/hide with entry/exit animation (exit = reversed entry).
    /// Replays an element's entry animation from the start without hiding it
    /// first — the way to actually judge one of the twenty styles while
    /// choosing. A no-op for hidden elements (there is nothing to show).
    func replayEntryAnimation(id: UUID) {
        guard let element = findElement(id: id), element.isVisible else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        elementAnimations[id] = .entering(startSeconds: now)
        recompileAndPublish()
        // Settle back to resting once it finishes, so the plan stops animating.
        let duration = element.entryAnimation.duration
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration + 0.1))
            guard let self else { return }
            self.elementAnimations[id] = .resting
            self.recompileAndPublish()
        }
    }

    func toggleElementVisibility(id: UUID) {
        guard var element = findElement(id: id) else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        if element.isVisible {
            elementAnimations[id] = .exiting(startSeconds: now)
            element.isVisible = false
        } else {
            elementAnimations[id] = .entering(startSeconds: now)
            element.isVisible = true
        }
        updateElement(element)   // triggers recompile via project.didSet
        // Recompile again after the animation completes to drop exited items.
        let duration = element.entryAnimation.duration
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration + 0.1))
            self?.recompileAndPublish()
        }
    }

    private func cleanupFinishedExits() {
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        elementAnimations = elementAnimations.filter { id, state in
            guard let element = findElement(id: id) else { return false }
            switch state {
            case .entering(let start):
                if now - start > element.entryAnimation.duration {
                    return false   // settled; .resting is the implicit default
                }
                return true
            case .exiting(let start):
                return now - start <= element.entryAnimation.duration
            case .resting:
                return false
            }
        }
    }

    // MARK: - Scenes

    func addScene(kind: SceneKind, name: String) {
        let scene = SceneModel(name: name, kind: kind)
        project.scenes.append(scene)
        if project.activeSceneID == nil { project.activeSceneID = scene.id }
    }

    func removeScene(id: UUID) {
        project.scenes.removeAll { $0.id == id }
        if project.activeSceneID == id {
            project.activeSceneID = project.scenes.first?.id
        }
    }

    // MARK: - Recording

    func toggleRecording() {
        if isRecording {
            isRecording = false
            recorder.stop { [weak self] url in
                Task { @MainActor in
                    guard let self else { return }
                    if let url {
                        self.log.info("Recording saved: \(url.path)")
                        self.lastRecordingURL = url
                        self.showingRecordingOptions = true
                    }
                }
            }
            audio.stopRecordingSink()
            renderEngine.map { $0.removeConsumer(recorder) }
        } else {
            do {
                try recorder.start(canvasSize: project.canvasSize,
                                   frameRate: project.frameRate,
                                   projectName: project.name)
                audio.startRecordingSink(recorder: recorder)
                renderEngine?.addConsumer(recorder)
                isRecording = true
            } catch {
                log.error("Couldn't start recording: \(error.localizedDescription)")
            }
        }
    }

    /// "Bad take" — removes the file that just finished writing.
    func discardLastRecording() {
        guard let url = lastRecordingURL else { return }
        try? FileManager.default.removeItem(at: url)
        lastRecordingURL = nil
    }

    func revealLastRecordingInFinder() {
        guard let url = lastRecordingURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func openLastRecordingInEditor() {
        guard let url = lastRecordingURL else { return }
        Task {
            if await !openEditor(fileURL: url) {
                log.error("Recording couldn't be opened in the editor: \(url.path)")
            }
        }
    }

    // MARK: - Going live with guests / podcast session

    func startGuestSession() async {
        guard let workerBaseURL else {
            log.error("Worker base URL not configured (Settings)")
            return
        }
        do {
            let session = try await podcast.createSession(baseURL: workerBaseURL)
            await guests?.connect(livekitURL: session.livekitUrl,
                                  token: session.hostToken,
                                  roomName: session.sessionId,
                                  inviteURL: URL(string: session.inviteUrl))
            isLive = true
        } catch {
            log.error("Couldn't start session: \(error.localizedDescription)")
        }
    }

    func endGuestSession() async {
        await guests?.disconnect()
        isLive = false
    }

    // MARK: - Edit mode

    func openEditor(tracks: [EditTrack], sessionId: String) {
        // EditProject's memberwise init requires an `edl:`; `make` builds the
        // initial EDL + layout cues from the imported tracks.
        let editProject = EditProject.make(sessionId: sessionId,
                                           name: "Session \(sessionId)",
                                           tracks: tracks)
        mode = .edit(editProject)
    }

    /// Opens the editor over a single file, with no session behind it.
    ///
    /// Probing is async, so this reports failure rather than opening an editor
    /// on something that can't be read.
    @discardableResult
    func openEditor(fileURL: URL) async -> Bool {
        let importer = ExternalMediaImporter()
        guard case .ready(let probe) = await importer.probe(fileURL), probe.duration > 0 else {
            return false
        }
        mode = .edit(EditProject.makeStandalone(media: MediaReference(url: fileURL), probe: probe))
        return true
    }

    func closeEditor() {
        mode = .live
    }
}

// MARK: - Frame consumers

/// Holds the latest program frame for the preview MTKView (display-only).
final class PreviewFrameStore: ProgramFrameConsumer {
    private let lock = NSLock()
    private var texture: MTLTexture?

    var latestTexture: MTLTexture? {
        lock.lock()
        defer { lock.unlock() }
        return texture
    }

    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime) {
        lock.lock()
        self.texture = texture
        lock.unlock()
    }
}

/// Pushes program frames into the camera extension's sink stream.
final class VirtualCameraFrameConsumer: ProgramFrameConsumer {
    private let writer: SinkStreamWriter

    init(writer: SinkStreamWriter) {
        self.writer = writer
    }

    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime) {
        writer.enqueue(pixelBuffer: pixelBuffer, at: time)
    }
}
