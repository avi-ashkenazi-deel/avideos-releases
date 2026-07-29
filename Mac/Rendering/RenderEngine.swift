import Foundation
import Metal
import CoreMedia
import CoreVideo
import os

/// Consumers of the composited program: preview, recorder, virtual camera.
/// `consume` is called on the render queue — take the buffer and get out.
protocol ProgramFrameConsumer: AnyObject {
    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime)
}

/// Owns the frame clock, the current render plan (+ scene transitions), the
/// program buffer pool, and fan-out to consumers. One instance per app.
final class RenderEngine {
    let device: MTLDevice
    let clock = FrameClock()
    let compositor: Compositor

    private let bufferPool: PixelBufferPool
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "render")

    /// The latest compiled plan, swapped atomically from the main actor.
    private let planLock = NSLock()
    private var currentPlan: RenderPlan = .empty
    private var activeTransition: SceneTransitionEngine.Transition?

    /// Consumer list mutated rarely (start/stop of recorder etc.).
    private let consumerLock = NSLock()
    private var consumers: [ProgramFrameConsumer] = []

    /// Source textures, provided by the SourceRegistry.
    var sourceTextureProvider: Compositor.SourceTextureProvider = { _, _ in nil }

    // Stats for the HUD.
    private(set) var lastFrameDuration: Double = 0
    private(set) var droppedFrames: Int = 0
    private(set) var renderedFrames: Int = 0

    init?() {
        guard let device = MTLCreateSystemDefaultDevice(),
              let compositor = Compositor(device: device),
              let pool = PixelBufferPool(device: device) else { return nil }
        self.device = device
        self.compositor = compositor
        self.bufferPool = pool

        clock.onTick = { [weak self] time in
            self?.renderFrame(at: time)
        }
    }

    func start(canvasSize: CGSize, fps: Int) {
        bufferPool.configure(width: Int(canvasSize.width), height: Int(canvasSize.height))
        clock.start(fps: fps)
    }

    /// Applies a new canvas size / frame rate to a RUNNING engine (the
    /// Shape & Size preferences). The pool rebuilds and flushes its old-size
    /// buffers, the clock restarts (`FrameClock.start` stops first), and
    /// everything downstream follows automatically: the compositor sizes off
    /// the target texture, the preview aspect-fits per draw, and the virtual
    /// camera's host side rebuilds its format description on width change.
    func reconfigure(canvasSize: CGSize, fps: Int) {
        bufferPool.configure(width: Int(canvasSize.width), height: Int(canvasSize.height))
        bufferPool.flush()
        clock.start(fps: fps)
    }

    func stop() {
        clock.stop()
    }

    // MARK: - Plan publication (main actor side)

    func publish(plan: RenderPlan) {
        planLock.lock()
        currentPlan = plan
        planLock.unlock()
    }

    /// Begins a scene transition; the render loop evaluates it per frame and
    /// drops it automatically once finished.
    func beginTransition(from: RenderPlan,
                         to: RenderPlan,
                         style: SceneTransitionStyle,
                         duration: TimeInterval) {
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        planLock.lock()
        if style == .cut || duration <= 0 {
            activeTransition = nil
            currentPlan = to
        } else {
            activeTransition = SceneTransitionEngine.Transition(
                from: from, to: to, style: style, startSeconds: now, duration: duration)
            currentPlan = to
        }
        planLock.unlock()
    }

    // MARK: - Consumers

    func addConsumer(_ consumer: ProgramFrameConsumer) {
        consumerLock.lock()
        if !consumers.contains(where: { $0 === consumer }) {
            consumers.append(consumer)
        }
        consumerLock.unlock()
    }

    func removeConsumer(_ consumer: ProgramFrameConsumer) {
        consumerLock.lock()
        consumers.removeAll { $0 === consumer }
        consumerLock.unlock()
    }

    // MARK: - Frame production (render queue)

    private func renderFrame(at time: CMTime) {
        let started = CFAbsoluteTimeGetCurrent()

        // Resolve the plan for this frame (transition-blended if one is live).
        planLock.lock()
        var plan = currentPlan
        if let transition = activeTransition {
            if transition.progress(at: time.seconds) >= 1 {
                activeTransition = nil
            } else {
                plan = SceneTransitionEngine.blend(transition, at: time.seconds)
            }
        }
        planLock.unlock()

        guard let (buffer, texture, textureRef) = bufferPool.acquire() else {
            // Pool exhausted — a consumer is holding buffers. Drop, count, move on.
            droppedFrames += 1
            return
        }

        // Hand off to consumers once the GPU finishes the frame. Consumers
        // retain the CVPixelBuffer for as long as they need it; the pool
        // recycles when everyone releases. The handler must be registered by
        // the compositor before it commits the command buffer.
        let handOff: (MTLCommandBuffer) -> Void = { [weak self] _ in
            // The CVMetalTexture wrapper must outlive the GPU's writes into
            // the program texture (CVMetalTextureCache contract).
            withExtendedLifetime(textureRef) {}
            guard let self else { return }
            self.consumerLock.lock()
            let targets = self.consumers
            self.consumerLock.unlock()
            for consumer in targets {
                consumer.consumeProgramFrame(buffer, texture: texture, at: time)
            }
        }

        guard compositor.render(plan: plan,
                                at: time,
                                into: texture,
                                sourceTextures: sourceTextureProvider,
                                onComplete: handOff) != nil else {
            droppedFrames += 1
            return
        }

        renderedFrames += 1
        lastFrameDuration = CFAbsoluteTimeGetCurrent() - started
    }
}
