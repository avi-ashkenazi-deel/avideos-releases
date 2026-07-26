import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import LiveKit
import os

/// Bridges one guest's LiveKit video track into a `GuestSource`. LiveKit
/// delivers frames on its own queue; the receiver extracts the CVPixelBuffer
/// and hands it to the source's NV12→BGRA ingest.
final class GuestVideoReceiver: VideoRenderer {
    let identity: String
    private weak var source: GuestSource?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "guest-video")

    init(identity: String, source: GuestSource) {
        self.identity = identity
        self.source = source
    }

    // MARK: - VideoRenderer

    /// LiveKit 2.x delivers `VideoFrame` whose buffer converts to a
    /// CVPixelBuffer. // verify on Mac: exact accessor — `frame.toCVPixelBuffer()`
    /// or `(frame.buffer as? CVPixelVideoBuffer)?.pixelBuffer` depending on
    /// the pinned SDK version.
    func render(frame: VideoFrame) {
        guard let pixelBuffer = frame.toCVPixelBuffer() else { return }
        let time = CMClockGetTime(CMClockGetHostTimeClock())
        source?.ingest(pixelBuffer: pixelBuffer, at: time)
    }

    func render(frame: VideoFrame, captureDevice: AVCaptureDevice?, captureOptions: VideoCaptureOptions?) {
        render(frame: frame)
    }

    // Renderer capability hints (SDK queries these; defaults are fine).
    var isAdaptiveStreamEnabled: Bool { true }
    var adaptiveStreamSize: CGSize { CGSize(width: 1280, height: 720) }
}

private extension VideoFrame {
    /// Normalizes the SDK's frame buffer to a CVPixelBuffer.
    /// // verify on Mac: LiveKit 2.x exposes `buffer.toPixelBuffer()` on
    /// CVPixelVideoBuffer and an I420 path that needs conversion; GuestSource
    /// handles NV12/BGRA — I420 frames convert via the SDK helper first.
    func toCVPixelBuffer() -> CVPixelBuffer? {
        if let cvBuffer = buffer as? CVPixelVideoBuffer {
            return cvBuffer.pixelBuffer
        }
        return buffer.toPixelBuffer()
    }
}
