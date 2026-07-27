import Foundation
import ScreenCaptureKit
import CoreMedia
import Metal
import os

/// Screen or window capture via ScreenCaptureKit, BGRA at the program rate.
final class ScreenSource: NSObject, FrameSource, SCStreamOutput, SCStreamDelegate {
    enum Target {
        case display(displayID: UInt32)
        case window(windowID: UInt32)
    }

    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let target: Target
    private let framesPerSecond: Int
    private let showsCursor: Bool
    private let mailbox = FrameMailbox()
    private let converter: PixelBufferTextureConverter
    private let outputQueue = DispatchQueue(label: "com.aviashkenazi.streamit.screen", qos: .userInteractive)
    private var stream: SCStream?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "screen")

    init(key: SourceKey,
         target: Target,
         framesPerSecond: Int,
         showsCursor: Bool,
         metalDevice: MTLDevice) {
        self.key = key
        self.target = target
        self.framesPerSecond = framesPerSecond
        self.showsCursor = showsCursor
        self.converter = PixelBufferTextureConverter(device: metalDevice)
        super.init()
    }

    func start() {
        guard state == .idle else { return }
        state = .starting
        Task { [weak self] in
            await self?.configureAndRun()
        }
    }

    private func configureAndRun() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

            let filter: SCContentFilter
            var size = CGSize(width: 1920, height: 1080)
            switch target {
            case .display(let displayID):
                guard let display = content.displays.first(where: { $0.displayID == displayID })
                        ?? content.displays.first else {
                    state = .failed("Display not found")
                    return
                }
                filter = SCContentFilter(display: display, excludingWindows: [])
                size = CGSize(width: display.width, height: display.height)
            case .window(let windowID):
                guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                    state = .failed("Window not found (was it closed?)")
                    return
                }
                filter = SCContentFilter(desktopIndependentWindow: window)
                size = window.frame.size
            }

            let config = SCStreamConfiguration()
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.width = Int(size.width)
            config.height = Int(size.height)
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(framesPerSecond))
            config.queueDepth = 3
            config.showsCursor = showsCursor

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
            try await stream.startCapture()
            self.stream = stream
            state = .running
        } catch {
            state = .failed(error.localizedDescription)
            log.error("Screen capture start failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        let stream = self.stream
        self.stream = nil
        mailbox.clear()
        state = .idle
        Task {
            try? await stream?.stopCapture()
        }
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        mailbox.latest()
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let converted = converter.texture(from: pixelBuffer) else { return }
        mailbox.put(SourceFrame(pixelBuffer: pixelBuffer,
                                texture: converted.texture,
                                presentationTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
                                textureRef: converted.textureRef))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        state = .failed(error.localizedDescription)
        log.error("Screen capture stopped: \(error.localizedDescription)")
    }
}
