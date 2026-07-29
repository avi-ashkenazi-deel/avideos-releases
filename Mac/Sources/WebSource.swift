import Foundation
import CoreMedia
import CoreGraphics
import Metal
import os

/// Live web-page overlay: OffscreenWebHost snapshots → BGRA textures.
/// Snapshot conversion happens on a utility queue; the mailbox pattern is the
/// same as every other source.
final class WebSource: FrameSource {
    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let content: WebContent
    private let device: MTLDevice
    private let mailbox = FrameMailbox()
    private let conversionQueue = DispatchQueue(label: "com.aviashkenazi.streamit.web-convert", qos: .utility)
    private var host: OffscreenWebHost?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "web")

    init(key: SourceKey, content: WebContent, metalDevice: MTLDevice) {
        self.key = key
        self.content = content
        self.device = metalDevice
    }

    func start() {
        guard state == .idle else { return }
        guard let url = URL(string: content.urlString), url.scheme?.hasPrefix("http") == true else {
            state = .failed("Invalid URL")
            return
        }
        state = .starting
        let pageSize = content.pageSize
        let fps = content.refreshFPS
        Task { @MainActor [weak self] in
            guard let self else { return }
            let host = OffscreenWebHost(pageSize: pageSize)
            host.onSnapshot = { [weak self] cgImage in
                self?.ingest(cgImage: cgImage)
            }
            host.load(url: url)
            host.startSnapshots(fps: fps)
            self.host = host
            self.state = .running
        }
    }

    /// Navigates the running page to the element's current URL. The source
    /// captured its content at init, so URL edits in the inspector must be
    /// pushed through here — the page never reloaded otherwise.
    func reload(content: WebContent) {
        guard let url = URL(string: content.urlString), url.scheme?.hasPrefix("http") == true else { return }
        Task { @MainActor [weak self] in
            self?.host?.load(url: url)
        }
    }

    /// Opens the live page in a normal window for clicking/scrolling.
    func openInteractiveWindow(title: String) {
        Task { @MainActor [weak self] in
            self?.host?.openInteractiveWindow(title: title)
        }
    }

    func stop() {
        state = .idle
        mailbox.clear()
        Task { @MainActor [weak self] in
            self?.host?.teardown()
            self?.host = nil
        }
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        mailbox.latest()
    }

    private func ingest(cgImage: CGImage) {
        conversionQueue.async { [weak self] in
            guard let self else { return }
            guard let texture = self.makeTexture(from: cgImage) else { return }
            self.mailbox.put(SourceFrame(pixelBuffer: nil,
                                         texture: texture,
                                         presentationTime: CMClockGetTime(CMClockGetHostTimeClock())))
        }
    }

    private func makeTexture(from cgImage: CGImage) -> MTLTexture? {
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return nil }

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        var data = Data(count: width * height * 4)
        let drawn: Bool = data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress,
                  let ctx = CGContext(data: base,
                                      width: width,
                                      height: height,
                                      bitsPerComponent: 8,
                                      bytesPerRow: width * 4,
                                      space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                          | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
            ctx.clear(CGRect(x: 0, y: 0, width: width, height: height))
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }

        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        desc.usage = [.shaderRead]
        guard let texture = device.makeTexture(descriptor: desc) else { return nil }
        data.withUnsafeBytes { raw in
            if let base = raw.baseAddress {
                texture.replace(region: MTLRegionMake2D(0, 0, width, height),
                                mipmapLevel: 0,
                                withBytes: base,
                                bytesPerRow: width * 4)
            }
        }
        return texture
    }
}
