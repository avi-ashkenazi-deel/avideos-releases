import Foundation
import CoreVideo
import CoreMedia
import Metal

/// Pool of IOSurface-backed BGRA program buffers. IOSurface backing is what
/// makes the hand-off to the CMIO extension zero-copy and keeps AVAssetWriter
/// cheap. Headroom of 8 absorbs the three consumers (preview, recorder,
/// virtual camera) holding buffers briefly; exhaustion DROPS the frame rather
/// than blocking the render tick.
final class PixelBufferPool {
    private var pool: CVPixelBufferPool?
    private(set) var width: Int = 0
    private(set) var height: Int = 0
    private let textureCache: CVMetalTextureCache

    /// BT.709 attachments so downstream consumers (encoder, CMIO clients)
    /// interpret the program correctly.
    private static let colorAttachments: [CFString: Any] = [
        kCVImageBufferColorPrimariesKey: kCVImageBufferColorPrimaries_ITU_R_709_2,
        kCVImageBufferTransferFunctionKey: kCVImageBufferTransferFunction_ITU_R_709_2,
        kCVImageBufferYCbCrMatrixKey: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
    ]

    init?(device: MTLDevice) {
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess,
              let cache else { return nil }
        self.textureCache = cache
    }

    func configure(width: Int, height: Int) {
        guard width != self.width || height != self.height else { return }
        self.width = width
        self.height = height
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferMetalCompatibilityKey: true,
        ]
        let poolAttrs: [CFString: Any] = [
            kCVPixelBufferPoolMinimumBufferCountKey: 8,
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, poolAttrs as CFDictionary, attrs as CFDictionary, &newPool)
        pool = newPool
    }

    /// A program buffer plus its Metal texture view, or nil when the pool is
    /// exhausted (consumers holding too many buffers) — callers drop the frame.
    /// `textureRef` is the CVMetalTexture wrapper backing `texture`; hold it
    /// until the GPU finishes writing the frame (CVMetalTextureCache contract).
    func acquire() -> (buffer: CVPixelBuffer, texture: MTLTexture, textureRef: CVMetalTexture)? {
        guard let pool else { return nil }
        var pb: CVPixelBuffer?
        // Enforce an allocation ceiling so a stuck consumer surfaces as
        // dropped frames (visible in the stats HUD), never as unbounded memory.
        let aux: [CFString: Any] = [kCVPixelBufferPoolAllocationThresholdKey: 12]
        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nil, pool, aux as CFDictionary, &pb)
        guard status == kCVReturnSuccess, let buffer = pb else { return nil }

        for (key, value) in Self.colorAttachments {
            CVBufferSetAttachment(buffer, key, value as CFTypeRef, .shouldPropagate)
        }

        var cvTexture: CVMetalTexture?
        CVMetalTextureCacheCreateTextureFromImage(
            nil, textureCache, buffer, nil, .bgra8Unorm,
            CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), 0, &cvTexture)
        guard let cvTexture, let texture = CVMetalTextureGetTexture(cvTexture) else { return nil }
        return (buffer, texture, cvTexture)
    }

    /// Flushes the Metal texture cache (call on canvas-size changes).
    func flush() {
        CVMetalTextureCacheFlush(textureCache, 0)
    }
}
