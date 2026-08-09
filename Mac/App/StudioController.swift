import Foundation
import AppKit
import AVFoundation
import CoreImage
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
    let prefs = AppPreferences()
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
    /// Countdown start per timer element — runtime state; a saved project
    /// must not resume mid-count. Restarts when the element is shown.
    /// Internal (not private) because the element factories live in
    /// StudioControllerElements.swift and `private` is file-scoped.
    var timerStarts: [UUID: Date] = [:]
    /// 1 Hz recompile while a visible timer element exists in the active
    /// scene; nil otherwise so timer-less scenes pay nothing.
    private var timerTick: DispatchSourceTimer?
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
    /// Paused mid-take. Same reason as `isRecording` for mirroring it here:
    /// ProgramRecorder isn't observable, so the button needs a stored copy.
    private(set) var isRecordingPaused = false

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
        self.project = Self.normalizingCameraFraming(
            ProjectStore.shared.loadMostRecentOrStarter())
        self.teleprompter = TeleprompterController()
        self.podcast = RecordingSessionController()
        self.guests = engine.map { GuestSessionController(metalDevice: $0.device) }
        self.virtualCameraConsumer = VirtualCameraFrameConsumer(writer: virtualCamera.sinkWriter)

        wireSubsystems()
    }

    /// Camera and interview scenes should COVER the canvas. Scenes whose
    /// framing was never configured (still exactly `.default`) are migrated
    /// on load, so an existing project stops letterboxing its camera the
    /// moment the program isn't 16:9.
    private static func normalizingCameraFraming(_ project: Project) -> Project {
        var copy = project
        for index in copy.scenes.indices {
            switch copy.scenes[index].kind {
            case .camera, .interview:
                if copy.scenes[index].primaryPresentation == .default {
                    copy.scenes[index].primaryPresentation = .camera
                }
            case .screenShare, .movie:
                break   // fit is right: cropping a shared screen loses content
            }
        }
        return copy
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
        sourceRegistry?.framesPerSecond = project.frameRate
        renderEngine?.start(canvasSize: project.canvasSize, fps: project.frameRate)
        recompileAndPublish()
        audio.start()
        // After audio, since every MIDI action lands on the audio facade.
        midi.start(audio: audio)
        virtualCamera.connectSinkIfNeeded()
        startThumbnailTimer()
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
                                              elementAnimations: elementAnimations,
                                              timerTexts: currentTimerTexts(scene: scene))
        engine.publish(plan: plan)
        updateTimerTick(scene: scene)
        ensureScenePrimarySources(for: scene)
        sourceRegistry?.activate(keys: SourceRegistry.keys(in: plan))
        syncWebPageSizes(scene: scene)
    }

    /// Switches scenes with the configured transition (magic move by default).
    func switchScene(to sceneID: UUID) {
        guard sceneID != project.activeSceneID,
              let engine = renderEngine,
              let fromScene = project.activeScene,
              let toScene = project.scenes.first(where: { $0.id == sceneID }) else { return }

        // Freeze the outgoing scene's last look for its palette tile.
        captureActiveSceneThumbnail()

        let guestList = guests?.guestDescriptors ?? []
        let fromPlan = RenderPlanCompiler.compile(project: project, scene: fromScene,
                                                  guests: guestList,
                                                  elementAnimations: elementAnimations,
                                                  timerTexts: currentTimerTexts(scene: fromScene))
        elementAnimations.removeAll()
        var toProject = project
        toProject.activeSceneID = sceneID
        let toPlan = RenderPlanCompiler.compile(project: toProject, scene: toScene,
                                                guests: guestList,
                                                elementAnimations: [:],
                                                timerTexts: currentTimerTexts(scene: toScene))

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

    /// Switches to the scene bound to ⌘N (explicit bindings win, the rest
    /// number by sidebar position — see `Project.sceneShortcuts`).
    func switchToScene(number: Int) {
        guard let match = project.sceneShortcuts.first(where: { $0.number == number }) else { return }
        switchScene(to: match.scene.id)
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
                                     muted: true, metalDevice: engine.device,
                                     autoplay: prefs.autoPlayMovies)
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

    // MARK: - Countdown timers

    /// Remaining-time strings for the scene's timer elements, for the plan.
    private func currentTimerTexts(scene: SceneModel) -> [UUID: String] {
        var texts: [UUID: String] = [:]
        for element in scene.elements {
            guard case .timer(let timer) = element.kind else { continue }
            let elapsed = timerStarts[element.id].map { Date().timeIntervalSince($0) } ?? 0
            texts[element.id] = TimerContent.formatted(timer.durationSeconds - elapsed)
        }
        return texts
    }

    private func updateTimerTick(scene: SceneModel) {
        let hasLiveTimer = scene.elements.contains {
            if case .timer = $0.kind { return $0.isVisible }
            return false
        }
        if hasLiveTimer, timerTick == nil {
            let tick = DispatchSource.makeTimerSource(queue: .main)
            tick.schedule(deadline: .now() + 1, repeating: 1)
            tick.setEventHandler { [weak self] in
                // The source fires on the main queue; hop the isolation.
                MainActor.assumeIsolated {
                    self?.recompileAndPublish()
                }
            }
            tick.resume()
            timerTick = tick
        } else if !hasLiveTimer, let tick = timerTick {
            tick.cancel()
            timerTick = nil
        }
    }

    /// Starts the countdown over (also what showing a hidden timer does).
    func restartTimer(id: UUID) {
        timerStarts[id] = Date()
        recompileAndPublish()
    }

    // MARK: - Web overlays (they are browsers)

    /// The element's bounding box IS the browser viewport: every recompile
    /// (which fires on drags/resizes) pushes the element's pixel size into
    /// the page so it relayouts like a resizing browser window.
    private func syncWebPageSizes(scene: SceneModel) {
        for element in scene.elements {
            guard case .web = element.kind, element.isVisible else { continue }
            let size = CGSize(width: element.transform.size.width * project.canvasSize.width,
                              height: element.transform.size.height * project.canvasSize.height)
            (sourceRegistry?.source(for: .web(elementID: element.id)) as? WebSource)?
                .setPageSize(size)
        }
    }

    /// Pushes the element's current URL into the running page — the source
    /// captures its content at start, so an edited URL must be re-fed.
    func reloadWebElement(id: UUID) {
        guard let element = findElement(id: id),
              case .web(let content) = element.kind else { return }
        (sourceRegistry?.source(for: .web(elementID: id)) as? WebSource)?
            .reload(content: content)
    }

    /// Opens the overlay's live page in a floating window to click/scroll/
    /// log in; the canvas keeps rendering it throughout.
    func openWebElementBrowser(id: UUID) {
        (sourceRegistry?.source(for: .web(elementID: id)) as? WebSource)?
            .openInteractiveWindow(title: findElement(id: id)?.name ?? "Browser")
    }

    // MARK: - Scene thumbnails ("what it looked like last time")

    /// The last rendered look of each scene, for the Scenes palette. Runtime
    /// state — never persisted.
    private(set) var sceneThumbnails: [UUID: CGImage] = [:]
    private var thumbnailTimer: DispatchSourceTimer?

    /// Refreshes the ACTIVE scene's thumbnail every few seconds; scene
    /// switches also capture the outgoing look, so inactive tiles show the
    /// scene as it last appeared on program.
    private func startThumbnailTimer() {
        guard thumbnailTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 3)
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                self?.captureActiveSceneThumbnail()
            }
        }
        timer.resume()
        thumbnailTimer = timer
    }

    private func captureActiveSceneThumbnail() {
        guard let sceneID = project.activeSceneID,
              let buffer = previewStore.latestPixelBuffer else { return }
        Task.detached(priority: .utility) { [weak self] in
            guard let image = Self.thumbnail(from: buffer) else { return }
            await MainActor.run {
                self?.sceneThumbnails[sceneID] = image
            }
        }
    }

    /// ~320px-wide CGImage from a program pixel buffer, off the main thread.
    nonisolated private static func thumbnail(from buffer: CVPixelBuffer) -> CGImage? {
        let image = CIImage(cvPixelBuffer: buffer)
        guard image.extent.width > 0 else { return nil }
        let scale = 320 / image.extent.width
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return sceneThumbnailContext.createCGImage(scaled, from: scaled.extent)
    }

    // MARK: - Shape & Size (program format)

    /// Applies a new canvas size / frame rate to the RUNNING studio — the
    /// Shape & Size preferences. Refused while recording (the pane disables
    /// itself; this guard is the backstop): an in-flight AVAssetWriter is
    /// pinned to its start dimensions.
    func applyCanvasSettings(size: CGSize, fps: Int) {
        guard !isRecording else {
            log.error("Canvas settings change refused while recording")
            return
        }
        let sizeChanged = project.canvasSize != size
        let fpsChanged = project.frameRate != fps
        guard sizeChanged || fpsChanged else { return }

        project.canvasSize = size
        project.frameRate = fps
        sourceRegistry?.framesPerSecond = fps
        renderEngine?.reconfigure(canvasSize: size, fps: fps)

        if fpsChanged, let registry = sourceRegistry {
            // Screen sources capture their frame rate at creation; drop them
            // so the recompile below rebuilds them at the new rate. Movie
            // scene primaries are left alone — restarting them mid-show to
            // change nothing would be worse.
            registry.unregisterScreenSources()
            for scene in project.scenes {
                if case .screenShare = scene.kind {
                    registry.unregister(key: .scenePrimary(sceneID: scene.id))
                }
            }
        }
        recompileAndPublish()
        if sizeChanged { matchStudioWindow(toAspect: size) }
    }

    /// Reshapes the studio window to the program's aspect and LOCKS it there,
    /// so a square or vertical show fills its window instead of sitting in
    /// black bars. AppKit enforces `contentAspectRatio` on every later
    /// user resize, which is exactly the behaviour asked for.
    private func matchStudioWindow(toAspect size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        // The studio window is the normal-level titled one; palettes float
        // and carry autosave names.
        guard let window = NSApp.windows.first(where: {
            $0.level == .normal && $0.styleMask.contains(.titled) && $0.isVisible
        }) else { return }

        let aspect = size.width / size.height
        window.contentAspectRatio = NSSize(width: aspect, height: 1)
        // Keep the current width, take the height the aspect implies, and
        // stay on screen.
        let currentContent = window.contentRect(forFrameRect: window.frame)
        var width = currentContent.width
        var height = width / aspect
        if let visible = window.screen?.visibleFrame {
            let maxHeight = visible.height - 60
            if height > maxHeight {
                height = maxHeight
                width = height * aspect
            }
        }
        window.setContentSize(NSSize(width: width, height: height))
    }

    // MARK: - Live camera switching

    /// The active scene's camera device, when it is a camera scene.
    var activeSceneCameraUID: String? {
        if case .camera(let config) = project.activeScene?.kind {
            return config.deviceUniqueID
        }
        return nil
    }

    var activeSceneIsCamera: Bool {
        if case .camera = project.activeScene?.kind { return true }
        return false
    }

    /// Switches the active camera scene to another device, live, with a fast
    /// dissolve — both cameras run through the fade, so the cut is smooth
    /// rather than a black gap while the new device spins up.
    func setActiveCamera(deviceUniqueID: String) {
        guard let index = project.scenes.firstIndex(where: { $0.id == project.activeSceneID }),
              case .camera(let current) = project.scenes[index].kind,
              current.deviceUniqueID != deviceUniqueID else { return }

        guard let engine = renderEngine, let scene = project.activeScene else {
            project.scenes[index].kind = .camera(CameraSceneConfig(deviceUniqueID: deviceUniqueID))
            return
        }

        let guestList = guests?.guestDescriptors ?? []
        let fromPlan = RenderPlanCompiler.compile(project: project, scene: scene,
                                                  guests: guestList,
                                                  elementAnimations: elementAnimations,
                                                  timerTexts: currentTimerTexts(scene: scene))
        var toProject = project
        toProject.scenes[index].kind = .camera(CameraSceneConfig(deviceUniqueID: deviceUniqueID))
        let toScene = toProject.scenes[index]
        let toPlan = RenderPlanCompiler.compile(project: toProject, scene: toScene,
                                                guests: guestList,
                                                elementAnimations: elementAnimations,
                                                timerTexts: currentTimerTexts(scene: toScene))

        // Both devices must produce frames through the fade.
        let unionKeys = SourceRegistry.keys(in: fromPlan).union(SourceRegistry.keys(in: toPlan))
        sourceRegistry?.activate(keys: unionKeys)

        engine.beginTransition(from: fromPlan, to: toPlan, style: .dissolve, duration: 0.25)
        project.scenes[index].kind = .camera(CameraSceneConfig(deviceUniqueID: deviceUniqueID))

        // Drop the outgoing camera once the fade lands.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.4))
            self?.recompileAndPublish()
        }
    }

    /// Duplicates a scene and switches to the copy. Elements KEEP their ids
    /// on purpose: `Element.transitionKey` falls back to the element id, so
    /// shared ids are what make magic move match a text/shape/image across
    /// the original and the copy — move a title in the copy and switching
    /// glides it there instead of fading it out and in. (Per-scene runtime
    /// state doesn't collide: elementAnimations clears on every switch.)
    func duplicateScene(id: UUID) {
        guard let index = project.scenes.firstIndex(where: { $0.id == id }) else { return }
        var copy = project.scenes[index]
        copy.id = UUID()
        copy.name += " Copy"
        copy.shortcutNumber = nil
        project.scenes.insert(copy, at: index + 1)
        project.activeSceneID = copy.id
    }

    // MARK: - Element editing

    /// Mutates the active scene in place; a no-op returning false when there
    /// is none. The firstIndex-then-guard dance was copy-pasted at six sites
    /// before it earned a name — every active-scene mutation goes through
    /// here now.
    @discardableResult
    private func withActiveScene(_ body: (inout SceneModel) -> Void) -> Bool {
        guard let index = project.scenes.firstIndex(where: { $0.id == project.activeSceneID })
        else { return false }
        body(&project.scenes[index])
        return true
    }

    func findElement(id: UUID) -> Element? {
        project.activeScene?.elements.first { $0.id == id }
    }

    func updateElement(_ element: Element) {
        withActiveScene { scene in
            guard let index = scene.elements.firstIndex(where: { $0.id == element.id }) else { return }
            scene.elements[index] = element
        }
    }

    func addElement(_ element: Element) {
        if withActiveScene({ $0.elements.append(element) }) {
            selectedElementID = element.id
        }
    }

    func removeElement(id: UUID) {
        guard withActiveScene({ $0.elements.removeAll { $0.id == id } }) else { return }
        elementAnimations.removeValue(forKey: id)
        timerStarts.removeValue(forKey: id)
        if selectedElementID == id { selectedElementID = nil }
    }

    // MARK: - Copy / paste elements between scenes

    /// The copied element, if any — an in-app clipboard so a layer can be
    /// lifted out of one scene and pasted into another (the natural way to
    /// move an overlay across scenes). Not the system pasteboard: these are
    /// document values, and clobbering the user's real clipboard while they
    /// work would be rude.
    private(set) var copiedElement: Element?
    var hasCopiedElement: Bool { copiedElement != nil }

    func copyElement(id: UUID) {
        copiedElement = findElement(id: id)
    }

    func cutElement(id: UUID) {
        copiedElement = findElement(id: id)
        removeElement(id: id)
    }

    /// Pastes the copied element into the ACTIVE scene, on top, with a fresh
    /// id — pasting into the scene it came from gives a real second copy, and
    /// pasting into another scene keeps both independent. Nudged slightly so
    /// the pasted copy is visibly distinct from the original.
    func pasteElement() {
        guard var element = copiedElement else { return }
        element.id = UUID()
        let pasted = withActiveScene { scene in
            if scene.elements.contains(where: {
                $0.transform.center == element.transform.center && $0.name == element.name
            }) {
                element.transform.center.x = min(element.transform.center.x + 0.03, 1)
                element.transform.center.y = min(element.transform.center.y + 0.03, 1)
                element.name += " Copy"
            }
            scene.elements.append(element)
        }
        if pasted { selectedElementID = element.id }
    }

    /// Reorders elements within the active scene (array order = z-order,
    /// later draws on top). List.onMove signature so the layers panel binds
    /// straight through.
    func moveElements(fromOffsets: IndexSet, toOffset: Int) {
        withActiveScene { $0.elements.move(fromOffsets: fromOffsets, toOffset: toOffset) }
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
            // Showing a countdown starts it over — the count while hidden
            // is never what a host means.
            if case .timer = element.kind {
                timerStarts[id] = Date()
            }
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
        // New scenes adopt the preferred transition (Video preferences), and
        // camera-ish scenes cover the canvas rather than letterboxing.
        let isCameraish: Bool
        switch kind {
        case .camera, .interview: isCameraish = true
        case .screenShare, .movie: isCameraish = false
        }
        let scene = SceneModel(name: name, kind: kind,
                               transitionStyle: prefs.defaultSceneTransition,
                               primaryPresentation: isCameraish ? .camera : .default)
        project.scenes.append(scene)
        if project.activeSceneID == nil { project.activeSceneID = scene.id }
    }

    /// The scene-list plus button's primary click: adds a scene of the
    /// preferred kind (Video preferences) without opening the menu.
    func addDefaultScene() {
        switch prefs.defaultSceneKind {
        case .camera: addScene(kind: .camera(CameraSceneConfig()), name: "Camera")
        case .screenShare: addScene(kind: .screenShare(ScreenSceneConfig()), name: "Screen Share")
        case .movie: addScene(kind: .movie(MovieSceneConfig()), name: "Movie")
        case .interview: addScene(kind: .interview(InterviewSceneConfig()), name: "Interview")
        }
    }

    func removeScene(id: UUID) {
        project.scenes.removeAll { $0.id == id }
        if project.activeSceneID == id {
            project.activeSceneID = project.scenes.first?.id
        }
    }

    // MARK: - Recording

    /// Non-nil while the record countdown runs; the Record button shows it.
    /// Pressing Record again during the count cancels.
    private(set) var recordingCountdown: Int?

    /// Wall time actually written to the file, paused spans excluded — the
    /// number the HUD counts up. Recomputed by the HUD's 1 Hz TimelineView, so
    /// it needs no observable mirror of its own.
    var recordingElapsed: TimeInterval { recorder.recordedDuration }

    /// Pause / resume mid-take. The file ends up gapless (see
    /// `ProgramRecorder.pause()`), so a pause is a hole in the *take*, not in
    /// the recording — the program keeps rendering and streaming throughout.
    func toggleRecordingPause() {
        guard isRecording else { return }
        isRecordingPaused.toggle()
        recorder.setPaused(isRecordingPaused)
    }

    func toggleRecording() {
        if isRecording {
            isRecording = false
            isRecordingPaused = false
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
        } else if recordingCountdown != nil {
            recordingCountdown = nil   // pressing again cancels the count
        } else if prefs.recordCountdown {
            recordingCountdown = 3
            Task { [weak self] in
                for remaining in stride(from: 3, through: 1, by: -1) {
                    guard let self, self.recordingCountdown != nil else { return }
                    self.recordingCountdown = remaining
                    try? await Task.sleep(for: .seconds(1))
                }
                guard let self, self.recordingCountdown != nil else { return }
                self.recordingCountdown = nil
                self.startRecordingNow()
            }
        } else {
            startRecordingNow()
        }
    }

    private func startRecordingNow() {
        do {
            try recorder.start(canvasSize: project.canvasSize,
                               frameRate: project.frameRate,
                               codec: prefs.recordingCodec,
                               projectName: project.name,
                               folderPath: prefs.recordingsFolderPath)
            audio.startRecordingSink(recorder: recorder)
            renderEngine?.addConsumer(recorder)
            isRecording = true
            isRecordingPaused = false
        } catch {
            log.error("Couldn't start recording: \(error.localizedDescription)")
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
    private var pixelBuffer: CVPixelBuffer?

    var latestTexture: MTLTexture? {
        lock.lock()
        defer { lock.unlock() }
        return texture
    }

    /// The latest program frame as a pixel buffer — scene thumbnails read it.
    var latestPixelBuffer: CVPixelBuffer? {
        lock.lock()
        defer { lock.unlock() }
        return pixelBuffer
    }

    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime) {
        lock.lock()
        self.texture = texture
        self.pixelBuffer = pixelBuffer
        lock.unlock()
    }
}

/// Shared by scene-thumbnail rendering (CIContext is thread-safe; a file
/// global keeps it out of StudioController's main-actor isolation, which
/// statics inherit).
private let sceneThumbnailContext = CIContext(options: [.cacheIntermediates: false])

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
