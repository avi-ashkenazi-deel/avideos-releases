import AVKit
import UIKit
import SwiftUI

/// Picture-in-Picture for the reader. iOS only floats *video* in PiP, so we render
/// what's being read (sender, current sentence, progress) into frames, push them
/// to an `AVSampleBufferDisplayLayer`, and drive PiP from that layer. The window
/// can auto-start when you leave the app mid-email.
///
/// NOTE: PiP only runs on a real device — it does nothing in the Simulator.
final class ReaderPiPController: NSObject, ObservableObject {
    static let shared = ReaderPiPController()

    /// The layer PiP renders from. Hosted (tiny/hidden) in the reading view.
    let displayLayer: AVSampleBufferDisplayLayer = {
        let layer = AVSampleBufferDisplayLayer()
        layer.videoGravity = .resizeAspect
        return layer
    }()

    private var controller: AVPictureInPictureController?

    /// Wired by the reading view so PiP's play/pause + skip drive the real player.
    var isPlayingProvider: (() -> Bool)?
    var onTogglePlay: (() -> Void)?
    var onSkip: ((_ forward: Bool) -> Void)?

    @Published private(set) var isActive = false

    // MARK: Lifecycle

    /// Create the PiP controller once the layer is in a window. Safe to call often.
    func setupIfNeeded() {
        guard controller == nil,
              AVPictureInPictureController.isPictureInPictureSupported() else { return }
        let source = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: displayLayer,
            playbackDelegate: self
        )
        let controller = AVPictureInPictureController(contentSource: source)
        controller.delegate = self
        self.controller = controller
    }

    /// Allow PiP to start automatically when the app is backgrounded mid-read.
    func setAutoStart(_ enabled: Bool) {
        setupIfNeeded()
        controller?.canStartPictureInPictureAutomaticallyFromInline = enabled
    }

    var isSupported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

    /// Manually start PiP (reliable trigger — auto-start-on-background can be
    /// flaky). Safe to call repeatedly.
    func start() {
        setupIfNeeded()
        guard let controller, !controller.isPictureInPictureActive else { return }
        controller.startPictureInPicture()
    }

    func stop() {
        controller?.stopPictureInPicture()
    }

    /// Stop auto-starting and clear the layer (leaving the reader / turning it off).
    func teardown() {
        controller?.canStartPictureInPictureAutomaticallyFromInline = false
        displayLayer.flushAndRemoveImage()
    }

    /// Refresh PiP's play/pause button after the player's state changes.
    func playbackStateChanged() {
        controller?.invalidatePlaybackState()
    }

    // MARK: Frame rendering

    /// Push a fresh frame showing what's currently being read.
    func render(header: String, sentence: String, progress: Double) {
        guard let buffer = Self.makeSampleBuffer(header: header, sentence: sentence, progress: progress) else { return }
        if displayLayer.status == .failed { displayLayer.flush() }
        displayLayer.enqueue(buffer)
    }

    private static let frameSize = CGSize(width: 480, height: 270)

    private static func makeSampleBuffer(header: String, sentence: String, progress: Double) -> CMSampleBuffer? {
        guard let pixelBuffer = makePixelBuffer(size: frameSize, header: header,
                                                sentence: sentence, progress: progress) else { return nil }
        var formatDesc: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDesc) == noErr, let formatDesc else { return nil }

        let now = CMClockGetTime(CMClockGetHostTimeClock())
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: now, decodeTimeStamp: .invalid)
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
            formatDescription: formatDesc, sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer) == noErr, let sampleBuffer else { return nil }

        // Show the newest frame right away.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sampleBuffer
    }

    private static func makePixelBuffer(size: CGSize, header: String, sentence: String,
                                        progress: Double) -> CVPixelBuffer? {
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ]
        var pb: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, Int(size.width), Int(size.height),
                                  kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb) == kCVReturnSuccess,
              let pixelBuffer = pb else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer),
            width: Int(size.width), height: Int(size.height),
            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return nil }

        // Draw with UIKit (flip into UIKit's top-left origin).
        ctx.translateBy(x: 0, y: size.height)
        ctx.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(ctx)
        draw(in: size, header: header, sentence: sentence, progress: progress)
        UIGraphicsPopContext()
        return pixelBuffer
    }

    private static func draw(in size: CGSize, header: String, sentence: String, progress: Double) {
        // Background.
        UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1).setFill()
        UIRectFill(CGRect(origin: .zero, size: size))

        let inset: CGFloat = 22
        let width = size.width - inset * 2

        // Header (sender • subject).
        let headerAttrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 18, weight: .semibold),
            .foregroundColor: UIColor(white: 0.7, alpha: 1)
        ]
        (header as NSString).draw(
            with: CGRect(x: inset, y: inset, width: width, height: 26),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: headerAttrs, context: nil)

        // Current sentence (the focus).
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail
        let bodyAttrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 30, weight: .bold),
            .foregroundColor: UIColor.white,
            .paragraphStyle: para
        ]
        (sentence as NSString).draw(
            with: CGRect(x: inset, y: inset + 36, width: width, height: size.height - inset * 2 - 36 - 26),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: bodyAttrs, context: nil)

        // Progress bar.
        let barHeight: CGFloat = 5
        let barY = size.height - inset - barHeight
        let track = CGRect(x: inset, y: barY, width: width, height: barHeight)
        let radius = barHeight / 2
        UIColor(white: 1, alpha: 0.2).setFill()
        UIBezierPath(roundedRect: track, cornerRadius: radius).fill()
        let clamped = max(0, min(1, progress))
        if clamped > 0 {
            let fill = CGRect(x: inset, y: barY, width: width * clamped, height: barHeight)
            UIColor.systemOrange.setFill()
            UIBezierPath(roundedRect: fill, cornerRadius: radius).fill()
        }
    }
}

// MARK: - Playback delegate (PiP transport → real player)

extension ReaderPiPController: AVPictureInPictureSampleBufferPlaybackDelegate {
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {
        if (isPlayingProvider?() ?? false) != playing { onTogglePlay?() }
    }

    func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        // Open-ended range → PiP shows a "live"-style control (no scrubber).
        CMTimeRange(start: .zero, duration: .positiveInfinity)
    }

    func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
        !(isPlayingProvider?() ?? false)
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                    didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                    skipByInterval skipInterval: CMTime,
                                    completion completionHandler: @escaping () -> Void) {
        onSkip?(skipInterval.seconds >= 0)
        completionHandler()
    }
}

// MARK: - Controller delegate (track active state)

extension ReaderPiPController: AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        isActive = true
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        isActive = false
    }
}

// MARK: - Host view

/// Hosts the (tiny, effectively invisible) `AVSampleBufferDisplayLayer` in the
/// reading view's hierarchy, which PiP requires.
struct PiPHostView: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        let layer = ReaderPiPController.shared.displayLayer
        layer.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
        view.layer.addSublayer(layer)
        ReaderPiPController.shared.setupIfNeeded()
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        ReaderPiPController.shared.displayLayer.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
    }
}
