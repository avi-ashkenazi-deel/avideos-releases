import Foundation
import Vision
import CoreVideo
import Metal
import os

/// Runs Vision person segmentation asynchronously on its own queue and keeps
/// the most recent mask texture available for the render thread. The mask is
/// deliberately allowed to be one frame late — invisible in practice, and it
/// keeps Vision entirely off the render path.
final class SegmentationProvider {
    private let device: MTLDevice
    private let queue = DispatchQueue(label: "com.aviashkenazi.avideos.segmentation", qos: .userInitiated)
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "segmentation")

    private var textureCache: CVMetalTextureCache?
    private let maskLock = NSLock()
    private var latestMask: MTLTexture?
    /// Keeps the CVMetalTexture wrapper — and through it the Vision mask's
    /// pixel buffer — alive for as long as `latestMask` is sampled
    /// (CVMetalTextureCache contract; nothing else retains the mask buffer).
    private var latestMaskRef: CVMetalTexture?
    private var inFlight = false

    init(device: MTLDevice) {
        self.device = device
        CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache)
    }

    /// The most recent person mask (OneComponent8; 1 = person), or nil before
    /// the first result lands.
    var currentMask: MTLTexture? {
        maskLock.lock()
        defer { maskLock.unlock() }
        return latestMask
    }

    /// Feeds a camera frame for segmentation. Drops the request if one is
    /// already in flight (mask cadence tracks Vision throughput, not fps).
    func submit(pixelBuffer: CVPixelBuffer) {
        maskLock.lock()
        let busy = inFlight
        if !busy { inFlight = true }
        maskLock.unlock()
        guard !busy else { return }

        queue.async { [weak self] in
            guard let self else { return }
            defer {
                self.maskLock.lock()
                self.inFlight = false
                self.maskLock.unlock()
            }

            let request = VNGeneratePersonSegmentationRequest()
            request.qualityLevel = .balanced
            request.outputPixelFormat = kCVPixelFormatType_OneComponent8

            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
            do {
                try handler.perform([request])
                guard let observation = request.results?.first else { return }
                let maskBuffer = observation.pixelBuffer
                if let (texture, textureRef) = self.makeTexture(from: maskBuffer) {
                    self.maskLock.lock()
                    self.latestMask = texture
                    self.latestMaskRef = textureRef
                    self.maskLock.unlock()
                }
            } catch {
                self.log.error("Person segmentation failed: \(error.localizedDescription)")
            }
        }
    }

    private func makeTexture(from pixelBuffer: CVPixelBuffer) -> (MTLTexture, CVMetalTexture)? {
        guard let cache = textureCache else { return nil }
        var cvTexture: CVMetalTexture?
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        CVMetalTextureCacheCreateTextureFromImage(
            nil, cache, pixelBuffer, nil, .r8Unorm, width, height, 0, &cvTexture)
        guard let cvTexture, let texture = CVMetalTextureGetTexture(cvTexture) else { return nil }
        return (texture, cvTexture)
    }
}
