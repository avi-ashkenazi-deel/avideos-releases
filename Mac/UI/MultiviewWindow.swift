import SwiftUI
import AppKit
import AVFoundation
import MetalKit
import CoreMedia

/// The Multiview: everything at a glance on one screen — PREVIEW and
/// PROGRAM up top, a tile per camera and per guest below, audio meters
/// along the bottom. Its own resizable window, so it can live on a second
/// display (Studio menu → Multiview Full Screen on Display…).
///
/// Display only. Nothing here is clickable on purpose: a multiview is
/// something you glance at while your hands are on the studio window.
struct MultiviewView: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        GeometryReader { geo in
            let programHeight = geo.size.height * 0.46
            VStack(spacing: 8) {
                // Top row: PREVIEW (studio mode) + PROGRAM.
                HStack(spacing: 8) {
                    if studio.studioModeEnabled {
                        monitor(store: studio.previewFrameStore,
                                label: "PREVIEW",
                                subtitle: studio.activeScene?.name,
                                color: .green)
                    }
                    monitor(store: studio.previewStore,
                            label: "PROGRAM",
                            subtitle: studio.project.activeScene?.name,
                            color: .red)
                }
                .frame(height: programHeight)

                // Middle: cameras and guests.
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 200, maximum: 360), spacing: 8)],
                              spacing: 8) {
                        ForEach(cameras, id: \.uniqueID) { device in
                            sourceTile(label: device.localizedName,
                                       isOnAir: isProgramCamera(device.uniqueID),
                                       badge: isProgramCamera(device.uniqueID) ? "ON AIR" : nil) {
                                CameraThumbnailView(deviceUniqueID: device.uniqueID, preset: .medium)
                            }
                        }
                        ForEach(guestTiles, id: \.key) { tile in
                            sourceTile(label: tile.name,
                                       isOnAir: tile.isOnAir,
                                       badge: tile.isOnAir ? "ON AIR" : "WAITING") {
                                SourceMonitorView(key: tile.key)
                            }
                        }
                    }
                }

                // Bottom: meters, one per strip.
                HStack(spacing: 10) {
                    ForEach(studio.audio.strips, id: \.self) { strip in
                        StripMeter(strip: strip)
                    }
                }
                .frame(height: 64)
            }
            .padding(8)
        }
        .background(Color.black)
        .background(MultiviewWindowConfigurator())
    }

    // MARK: - Pieces

    private func monitor(store: PreviewFrameStore, label: String,
                         subtitle: String?, color: Color) -> some View {
        ZStack {
            if let engine = studio.renderEngine {
                ProgramPreviewView(previewStore: store,
                                   device: engine.device,
                                   framesPerSecond: studio.project.frameRate)
            } else {
                Color.black
            }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 6) {
                Text(label).font(.caption.weight(.heavy))
                if let subtitle {
                    Text(subtitle).font(.caption).opacity(0.85)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.85), in: Capsule())
            .foregroundStyle(.white)
            .padding(8)
        }
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(color, lineWidth: 2))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sourceTile<Content: View>(label: String,
                                            isOnAir: Bool,
                                            badge: String?,
                                            @ViewBuilder content: () -> Content) -> some View {
        content()
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(isOnAir ? Color.red : .white.opacity(0.15),
                                  lineWidth: isOnAir ? 2 : 1)
            )
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: 6) {
                    Text(label).font(.caption).lineLimit(1)
                    if let badge {
                        Text(badge)
                            .font(.system(size: 9, weight: .heavy))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background((isOnAir ? Color.red : .gray).opacity(0.85), in: Capsule())
                    }
                }
                .foregroundStyle(.white)
                .padding(6)
                .background(.black.opacity(0.45), in: Capsule())
                .padding(6)
            }
    }

    // MARK: - Data

    private var cameras: [AVCaptureDevice] {
        CameraSource.availableCameras().sorted {
            $0.localizedName.localizedCaseInsensitiveCompare($1.localizedName) == .orderedAscending
        }
    }

    private func isProgramCamera(_ uid: String) -> Bool {
        guard case .camera = studio.project.activeScene?.kind else { return false }
        if let active = studio.activeSceneCameraUID { return active == uid }
        return uid == CameraSource.device(uniqueID: nil)?.uniqueID
    }

    private struct GuestTile {
        let key: SourceKey
        let name: String
        let isOnAir: Bool
    }

    /// Real guests (camera + any shared screen) and rehearsal stand-ins.
    private var guestTiles: [GuestTile] {
        var tiles: [GuestTile] = []
        for guest in studio.guests?.guests ?? [] {
            tiles.append(GuestTile(key: .guest(identity: guest.identity),
                                   name: guest.displayName,
                                   isOnAir: guest.isOnAir))
            if guest.isSharingScreen {
                tiles.append(GuestTile(key: .guestScreen(identity: guest.identity),
                                       name: "\(guest.displayName)'s Screen",
                                       isOnAir: guest.isOnAir))
            }
        }
        for demo in studio.demoGuestDescriptors {
            tiles.append(GuestTile(key: .guest(identity: demo.identity),
                                   name: demo.displayName,
                                   isOnAir: true))
        }
        return tiles
    }
}

/// A compact level meter for one mixer strip: name, live RMS bar, red when
/// muted.
private struct StripMeter: View {
    @Environment(StudioController.self) private var studio
    let strip: AudioEngineController.StripID

    var body: some View {
        let audio = studio.audio
        let muted = audio.isMuted(strip)
        VStack(spacing: 4) {
            TimelineView(.animation) { _ in
                GeometryReader { geo in
                    let level = CGFloat(min(max(audio.levels(for: strip).rms * 1.5, 0), 1))
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.1))
                        Capsule()
                            .fill(LinearGradient(colors: [.green, .green, .yellow, .red],
                                                 startPoint: .leading, endPoint: .trailing))
                            .frame(width: max(4, geo.size.width * level))
                            .opacity(muted ? 0.3 : 1)
                    }
                }
            }
            .frame(height: 10)
            HStack(spacing: 4) {
                if muted { Image(systemName: "speaker.slash.fill").font(.caption2) }
                Text(audio.displayName(for: strip))
                    .font(.caption2)
                    .lineLimit(1)
            }
            .foregroundStyle(muted ? .red : .secondary)
        }
        .frame(minWidth: 90, maxWidth: .infinity)
    }
}

/// Draws the latest texture of one live source straight from the registry
/// (a guest's camera or screen) — the same shader the program preview
/// uses, paced by a main-queue timer for the run-loop-mode reason
/// documented in `ProgramPreviewView`.
struct SourceMonitorView: NSViewRepresentable {
    @Environment(StudioController.self) private var studio
    let key: SourceKey

    func makeCoordinator() -> Renderer {
        Renderer(device: studio.renderEngine?.device,
                 registry: studio.sourceRegistry,
                 key: key)
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: studio.renderEngine?.device)
        view.colorPixelFormat = .bgra8Unorm
        view.delegate = context.coordinator
        view.layer?.backgroundColor = NSColor.black.cgColor
        view.isPaused = true
        view.enableSetNeedsDisplay = true
        context.coordinator.start(view: view)
        return view
    }

    func updateNSView(_ nsView: MTKView, context: Context) {}

    static func dismantleNSView(_ nsView: MTKView, coordinator: Renderer) {
        coordinator.stop()
    }

    final class Renderer: NSObject, MTKViewDelegate {
        private let registry: SourceRegistry?
        private let key: SourceKey
        private let commandQueue: MTLCommandQueue?
        private var pipeline: MTLRenderPipelineState?
        private let sampler: MTLSamplerState?
        private var timer: DispatchSourceTimer?
        private weak var view: MTKView?

        struct Uniforms {
            var scale: SIMD2<Float>
            var pad: SIMD2<Float> = .zero
        }

        init(device: MTLDevice?, registry: SourceRegistry?, key: SourceKey) {
            self.registry = registry
            self.key = key
            self.commandQueue = device?.makeCommandQueue()
            let samplerDesc = MTLSamplerDescriptor()
            samplerDesc.minFilter = .linear
            samplerDesc.magFilter = .linear
            self.sampler = device?.makeSamplerState(descriptor: samplerDesc)
            if let device, let library = device.makeDefaultLibrary(),
               let vertex = library.makeFunction(name: "preview_vertex"),
               let fragment = library.makeFunction(name: "preview_fragment") {
                let desc = MTLRenderPipelineDescriptor()
                desc.vertexFunction = vertex
                desc.fragmentFunction = fragment
                desc.colorAttachments[0].pixelFormat = .bgra8Unorm
                self.pipeline = try? device.makeRenderPipelineState(descriptor: desc)
            }
            super.init()
        }

        func start(view: MTKView) {
            self.view = view
            let t = DispatchSource.makeTimerSource(queue: .main)
            // 15 fps is plenty for a monitor tile.
            t.schedule(deadline: .now(), repeating: 1.0 / 15.0)
            t.setEventHandler { [weak self] in self?.view?.needsDisplay = true }
            timer = t
            t.resume()
        }

        func stop() {
            timer?.cancel()
            timer = nil
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        func draw(in view: MTKView) {
            guard let pipeline, let commandQueue,
                  let texture = registry?.texture(for: key, at: CMClockGetTime(CMClockGetHostTimeClock())),
                  let descriptor = view.currentRenderPassDescriptor,
                  let drawable = view.currentDrawable,
                  let commandBuffer = commandQueue.makeCommandBuffer(),
                  let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)
            else { return }
            let viewAspect = Float(view.drawableSize.width / max(view.drawableSize.height, 1))
            let texAspect = Float(texture.width) / Float(max(texture.height, 1))
            var uniforms = Uniforms(scale: viewAspect > texAspect
                ? SIMD2(viewAspect / texAspect, 1)
                : SIMD2(1, texAspect / viewAspect))
            encoder.setRenderPipelineState(pipeline)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
            encoder.setFragmentTexture(texture, index: 0)
            if let sampler { encoder.setFragmentSamplerState(sampler, index: 0) }
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.endEncoding()
            commandBuffer.present(drawable)
            commandBuffer.commit()
        }
    }
}

/// Window furniture for the Multiview: dark title bar, remembers its frame,
/// and the "send to display" helper the Studio menu calls.
private struct MultiviewWindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.titlebarAppearsTransparent = true
            window.backgroundColor = .black
            window.setFrameAutosaveName("multiview")
            window.collectionBehavior.insert(.fullScreenPrimary)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

enum Multiview {
    /// The SwiftUI `Window(id: "multiview")` as an NSWindow, if open.
    @MainActor
    static var window: NSWindow? {
        NSApp.windows.first { $0.identifier?.rawValue.hasPrefix("multiview") == true }
    }

    /// Fills the given display with the Multiview: move there, then native
    /// full screen (the green button's mode), so it survives Spaces changes.
    @MainActor
    static func send(toScreen screen: NSScreen) {
        guard let window else { return }
        if window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)   // leave the current display first
        }
        window.setFrame(screen.visibleFrame, display: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            if !window.styleMask.contains(.fullScreen) {
                window.toggleFullScreen(nil)
            }
        }
    }
}
