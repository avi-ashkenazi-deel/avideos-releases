import Foundation
import CoreMedia
import Metal
import MetalKit

/// Still image as a frame source — loads once, returns the same frame forever.
final class ImageSource: FrameSource {
    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let url: URL
    private let device: MTLDevice
    private var frame: SourceFrame?

    init(key: SourceKey, url: URL, metalDevice: MTLDevice) {
        self.key = key
        self.url = url
        self.device = metalDevice
    }

    func start() {
        guard state == .idle else { return }
        state = .starting
        let loader = MTKTextureLoader(device: device)
        do {
            let texture = try loader.newTexture(URL: url, options: [
                .SRGB: false,
                .textureUsage: NSNumber(value: MTLTextureUsage.shaderRead.rawValue),
            ])
            frame = SourceFrame(pixelBuffer: nil,
                                texture: texture,
                                presentationTime: .zero)
            state = .running
        } catch {
            state = .failed("Couldn't load image: \(error.localizedDescription)")
        }
    }

    func stop() {
        frame = nil
        state = .idle
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        frame
    }
}
