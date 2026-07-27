import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import LiveKit
import os

/// Bridges one guest's LiveKit video track into a `GuestSource`. LiveKit
/// delivers frames on its own queue; the receiver extracts the CVPixelBuffer
/// and hands it to the source's NV12→BGRA ingest.
/// NSObject-derived on purpose. `VideoRenderer` is an `@objc` protocol whose
/// `render` requirements are **optional**, so the SDK reaches them with
/// `renderer?.render?(frame:)` — ObjC optional dispatch, which needs a real
/// ObjC class behind it. A plain Swift class type-checks and then never
/// receives a frame. `@unchecked Sendable` because the protocol demands
/// Sendable and the only mutable state is a weak back-reference.
final class GuestVideoReceiver: NSObject, VideoRenderer, @unchecked Sendable {
    let identity: String
    private weak var source: GuestSource?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "guest-video")

    init(identity: String, source: GuestSource) {
        self.identity = identity
        self.source = source
        super.init()
    }

    // MARK: - VideoRenderer

    /// `VideoFrame.toCVPixelBuffer()` is the SDK's own public helper: it
    /// unwraps a `CVPixelVideoBuffer` directly and converts an
    /// `I420VideoBuffer`, which is exactly the two cases a remote track
    /// delivers. GuestSource then handles NV12/BGRA.
    func render(frame: VideoFrame) {
        guard let pixelBuffer = frame.toCVPixelBuffer() else { return }
        let time = CMClockGetTime(CMClockGetHostTimeClock())
        source?.ingest(pixelBuffer: pixelBuffer, at: time)
    }

    // Deliberately NOT implementing the
    // `render(frame:captureDevice:captureOptions:)` overload. The SDK's
    // adapter calls *both* forms for every frame, so implementing both would
    // convert and ingest each frame twice. Capture metadata is nil for remote
    // tracks anyway.

    // Renderer capability hints (SDK queries these on the main thread).
    @MainActor var isAdaptiveStreamEnabled: Bool { true }
    @MainActor var adaptiveStreamSize: CGSize { CGSize(width: 1280, height: 720) }
}
