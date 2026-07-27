import Foundation
import CoreVideo
import CoreMedia
import Metal
import os

/// A remote guest's video as a frame source. LiveKit delivers CVPixelBuffers
/// (usually NV12, occasionally BGRA) on its own delegate queue; frames are
/// normalized to BGRA at ingest with a compute kernel so the compositor's
/// uniform-BGRA invariant holds.
final class GuestSource: FrameSource {
    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let device: MTLDevice
    private let mailbox = FrameMailbox()
    private let commandQueue: MTLCommandQueue?
    private let nv12Pipeline: MTLComputePipelineState?
    private var textureCache: CVMetalTextureCache?
    private let converter: PixelBufferTextureConverter

    /// Rotating output textures so conversion never waits on the render pass.
    private var outputRing: [MTLTexture] = []
    private var ringIndex = 0
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "guest-video")

    struct YCbCrUniforms {
        var fullRange: Float
        var pad: SIMD3<Float> = .zero
    }

    init(key: SourceKey, metalDevice: MTLDevice) {
        self.key = key
        self.device = metalDevice
        self.converter = PixelBufferTextureConverter(device: metalDevice)
        self.commandQueue = metalDevice.makeCommandQueue()
        CVMetalTextureCacheCreate(nil, nil, metalDevice, nil, &textureCache)
        if let library = metalDevice.makeDefaultLibrary(),
           let fn = library.makeFunction(name: "nv12ToBGRA") {
            self.nv12Pipeline = try? metalDevice.makeComputePipelineState(function: fn)
        } else {
            self.nv12Pipeline = nil
        }
    }

    func start() { state = .running }

    func stop() {
        mailbox.clear()
        state = .idle
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        mailbox.latest()
    }

    /// Called by GuestVideoReceiver on LiveKit's delegate queue.
    func ingest(pixelBuffer: CVPixelBuffer, at time: CMTime) {
        let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
        switch format {
        case kCVPixelFormatType_32BGRA:
            guard let converted = converter.texture(from: pixelBuffer) else { return }
            mailbox.put(SourceFrame(pixelBuffer: pixelBuffer,
                                    texture: converted.texture,
                                    presentationTime: time,
                                    textureRef: converted.textureRef))
        case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
             kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
            let fullRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            guard let texture = convertNV12(pixelBuffer, fullRange: fullRange) else { return }
            mailbox.put(SourceFrame(pixelBuffer: nil, texture: texture, presentationTime: time))
        default:
            log.warning("Unsupported guest pixel format \(format); dropping frame")
        }
    }

    private func convertNV12(_ pixelBuffer: CVPixelBuffer, fullRange: Bool) -> MTLTexture? {
        guard let cache = textureCache,
              let pipeline = nv12Pipeline,
              let queue = commandQueue else { return nil }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        var yTextureRef: CVMetalTexture?
        CVMetalTextureCacheCreateTextureFromImage(
            nil, cache, pixelBuffer, nil, .r8Unorm, width, height, 0, &yTextureRef)
        var cbcrTextureRef: CVMetalTexture?
        CVMetalTextureCacheCreateTextureFromImage(
            nil, cache, pixelBuffer, nil, .rg8Unorm, width / 2, height / 2, 1, &cbcrTextureRef)
        guard let yRef = yTextureRef, let cbcrRef = cbcrTextureRef,
              let yTexture = CVMetalTextureGetTexture(yRef),
              let cbcrTexture = CVMetalTextureGetTexture(cbcrRef) else { return nil }

        let output = nextOutputTexture(width: width, height: height)
        guard let output,
              let commandBuffer = queue.makeCommandBuffer(),
              let encoder = commandBuffer.makeComputeCommandEncoder() else { return nil }

        var uniforms = YCbCrUniforms(fullRange: fullRange ? 1 : 0)
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(yTexture, index: 0)
        encoder.setTexture(cbcrTexture, index: 1)
        encoder.setTexture(output, index: 2)
        encoder.setBytes(&uniforms, length: MemoryLayout<YCbCrUniforms>.stride, index: 0)
        let w = pipeline.threadExecutionWidth
        let h = max(1, pipeline.maxTotalThreadsPerThreadgroup / w)
        encoder.dispatchThreadgroups(
            MTLSize(width: (width + w - 1) / w, height: (height + h - 1) / h, depth: 1),
            threadsPerThreadgroup: MTLSize(width: w, height: h, depth: 1))
        encoder.endEncoding()
        // Keep the CVMetalTexture wrappers (and the LiveKit pixel buffer they
        // view) alive until the GPU has read them — the caller may recycle
        // the buffer as soon as ingest returns.
        commandBuffer.addCompletedHandler { _ in
            _ = yRef
            _ = cbcrRef
            _ = pixelBuffer
        }
        commandBuffer.commit()
        // No waitUntilCompleted: the mailbox swap happens now, and by the time
        // the render pass samples this texture the tiny conversion has long
        // finished; Metal hazard tracking orders access within the device.
        // verify on Mac: automatic hazard tracking across *different* command
        // queues is not contractually guaranteed. If guest tiles ever show
        // shearing/flicker, signal an MTLSharedEvent after this commit and
        // wait on it from the compositor's queue (or convert there directly).
        return output
    }

    private func nextOutputTexture(width: Int, height: Int) -> MTLTexture? {
        if let first = outputRing.first, first.width == width, first.height == height {
            ringIndex = (ringIndex + 1) % outputRing.count
            return outputRing[ringIndex]
        }
        outputRing.removeAll()
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        desc.usage = [.shaderRead, .shaderWrite]
        desc.storageMode = .private
        for _ in 0..<3 {
            if let tex = device.makeTexture(descriptor: desc) {
                outputRing.append(tex)
            }
        }
        ringIndex = 0
        return outputRing.first
    }
}
