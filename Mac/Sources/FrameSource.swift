import Foundation
import CoreVideo
import CoreMedia
import Metal
import os

/// One video frame as the compositor consumes it: BGRA texture + timing.
struct SourceFrame {
    let pixelBuffer: CVPixelBuffer?
    let texture: MTLTexture
    let presentationTime: CMTime
    /// The CVMetalTexture wrapper backing `texture` when it came through a
    /// CVMetalTextureCache — retained for as long as this frame is current
    /// (CVMetalTextureCache contract). Nil for plain MTLTexture content.
    var textureRef: CVMetalTexture? = nil
}

enum FrameSourceState: Equatable {
    case idle
    case starting
    case running
    case failed(String)
}

/// A producer of video frames: camera, screen, movie, web page, guest, image.
///
/// Threading model: each source owns its delivery queue; callbacks convert
/// the incoming frame to a BGRA Metal texture and drop it into a
/// `FrameMailbox`. The render thread calls `latestFrame(at:)`, which must be
/// cheap and non-blocking — it just reads the mailbox slot.
protocol FrameSource: AnyObject {
    var key: SourceKey { get }
    var state: FrameSourceState { get }
    func start()
    func stop()
    /// Most recent frame, or nil (compositor skips or reuses placeholder).
    func latestFrame(at time: CMTime) -> SourceFrame?
}

/// Single-slot, lock-guarded frame holder. The lock protects one pointer
/// swap (~tens of ns) — deliberately boring and correct.
final class FrameMailbox {
    private var frame: SourceFrame?
    private var lock = os_unfair_lock()

    func put(_ newFrame: SourceFrame) {
        os_unfair_lock_lock(&lock)
        frame = newFrame
        os_unfair_lock_unlock(&lock)
    }

    func latest() -> SourceFrame? {
        os_unfair_lock_lock(&lock)
        let f = frame
        os_unfair_lock_unlock(&lock)
        return f
    }

    func clear() {
        os_unfair_lock_lock(&lock)
        frame = nil
        os_unfair_lock_unlock(&lock)
    }
}

/// Shared helper: CVPixelBuffer (BGRA) -> MTLTexture through a texture cache.
final class PixelBufferTextureConverter {
    private var cache: CVMetalTextureCache?

    init(device: MTLDevice) {
        CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
    }

    /// Returns the texture plus its CVMetalTexture wrapper; keep the wrapper
    /// alive (e.g. in the `SourceFrame`) while the texture is in use.
    func texture(from pixelBuffer: CVPixelBuffer) -> (texture: MTLTexture, textureRef: CVMetalTexture)? {
        guard let cache else { return nil }
        var cvTexture: CVMetalTexture?
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let status = CVMetalTextureCacheCreateTextureFromImage(
            nil, cache, pixelBuffer, nil, .bgra8Unorm, width, height, 0, &cvTexture)
        guard status == kCVReturnSuccess, let cvTexture,
              let texture = CVMetalTextureGetTexture(cvTexture) else { return nil }
        return (texture, cvTexture)
    }

    func flush() {
        if let cache { CVMetalTextureCacheFlush(cache, 0) }
    }
}
