//
//  SplashFrameGenerator.swift
//  CameraExtension — AVideos Studio virtual camera (CoreMediaIO system extension)
//
//  Renders the "Studio isn't live" splash frame that the extension sends when
//  no app is feeding the sink stream. The frame is drawn ONCE per format size
//  with CoreGraphics/CoreText into an IOSurface-backed CVPixelBuffer drawn
//  from a CVPixelBufferPool, then cached and re-sent verbatim on every timer
//  tick — steady-state cost is just wrapping the cached buffer in a new
//  CMSampleBuffer with fresh timing (done by the caller).
//
//  Layout (proportional to frame height, so 720p and 1080p look identical):
//
//        ┌──────────────────────────────┐
//        │                              │
//        │           AVideos            │   ← wordmark, white, bold
//        │      ● Studio isn't live     │   ← red dot + gray subtitle
//        │                              │
//        └──────────────────────────────┘
//

import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import CoreText

final class SplashFrameGenerator {

    struct Splash {
        let pixelBuffer: CVPixelBuffer
        let formatDescription: CMVideoFormatDescription
    }

    /// Cached rendered frames keyed by "WxH". The buffers live for the
    /// process lifetime and are never written to after rendering, so sharing
    /// one buffer across every subsequent send is safe.
    private var cache: [String: Splash] = [:]

    /// Pools kept alive alongside their vended buffer (one per size).
    private var pools: [String: CVPixelBufferPool] = [:]

    /// Callers are expected to be on a single serial queue (the device
    /// source's state queue); the lock is cheap insurance against misuse.
    private let lock = NSLock()

    /// Returns the cached splash frame for the given size, rendering it on
    /// first request. Returns nil only if buffer allocation/rendering fails.
    func splash(width: Int, height: Int) -> Splash? {
        lock.lock()
        defer { lock.unlock() }

        let key = "\(width)x\(height)"
        if let cached = cache[key] {
            return cached
        }

        guard let pool = makePool(width: width, height: height) else { return nil }
        pools[key] = pool

        var pixelBufferOut: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBufferOut) == kCVReturnSuccess,
              let pixelBuffer = pixelBufferOut else {
            return nil
        }

        guard render(into: pixelBuffer, width: width, height: height) else { return nil }

        // Derive the format description from the actual buffer so extensions
        // (color attachments, IOSurface backing) match what we send.
        var descriptionOut: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &descriptionOut
        ) == noErr, let description = descriptionOut else {
            return nil
        }

        let splash = Splash(pixelBuffer: pixelBuffer, formatDescription: description)
        cache[key] = splash
        return splash
    }

    // MARK: - Buffer allocation

    private func makePool(width: Int, height: Int) -> CVPixelBufferPool? {
        let pixelBufferAttributes: [String: Any] = [
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            // IOSurface backing is required for zero-copy delivery to CMIO
            // stream clients.
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]
        let poolAttributes: [String: Any] = [
            kCVPixelBufferPoolMinimumBufferCountKey as String: 1,
        ]
        var pool: CVPixelBufferPool?
        let status = CVPixelBufferPoolCreate(
            kCFAllocatorDefault,
            poolAttributes as CFDictionary,
            pixelBufferAttributes as CFDictionary,
            &pool
        )
        return status == kCVReturnSuccess ? pool : nil
    }

    // MARK: - Rendering

    private func render(into pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> Bool {
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return false }

        // BGRA little-endian == premultiplied ARGB with 32-bit little-endian
        // byte order from CoreGraphics' point of view.
        guard let context = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            return false
        }

        let w = CGFloat(width)
        let h = CGFloat(height)

        // Background: near-black base with a subtle centered glow so the
        // frame reads as "designed", not "dead signal".
        context.setFillColor(CGColor(red: 0.043, green: 0.043, blue: 0.055, alpha: 1)) // #0B0B0E
        context.fill(CGRect(x: 0, y: 0, width: w, height: h))

        if let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [
                CGColor(red: 0.106, green: 0.106, blue: 0.137, alpha: 1), // #1B1B23 center
                CGColor(red: 0.043, green: 0.043, blue: 0.055, alpha: 0), // fade to base
            ] as CFArray,
            locations: [0.0, 1.0]
        ) {
            context.drawRadialGradient(
                gradient,
                startCenter: CGPoint(x: w / 2, y: h * 0.55),
                startRadius: 0,
                endCenter: CGPoint(x: w / 2, y: h * 0.55),
                endRadius: h * 0.75,
                options: []
            )
        }

        // Wordmark. HelveticaNeue ships with macOS; no font lookup can fail
        // silently into Times because we name the face explicitly.
        let wordmarkFont = CTFontCreateWithName("HelveticaNeue-Bold" as CFString, h * 0.125, nil)
        let subtitleFont = CTFontCreateWithName("HelveticaNeue-Medium" as CFString, h * 0.042, nil)

        let white = CGColor(red: 0.96, green: 0.96, blue: 0.98, alpha: 1)
        let gray = CGColor(red: 0.58, green: 0.58, blue: 0.64, alpha: 1)

        // CG origin is bottom-left; baselines are placed proportionally.
        let wordmarkBaselineY = h * 0.50
        let subtitleBaselineY = h * 0.395

        drawCentered(text: "AVideos", font: wordmarkFont, color: white,
                     baselineY: wordmarkBaselineY, in: context, canvasWidth: w)

        let subtitleBounds = drawCentered(text: "Studio isn't live", font: subtitleFont, color: gray,
                                          baselineY: subtitleBaselineY, in: context, canvasWidth: w)

        // Status dot to the left of the subtitle, vertically centered on its
        // x-height.
        if let subtitleBounds {
            let dotRadius = h * 0.010
            let dotCenter = CGPoint(
                x: subtitleBounds.minX - dotRadius * 3.2,
                y: subtitleBaselineY + subtitleBounds.height * 0.32
            )
            context.setFillColor(CGColor(red: 0.86, green: 0.22, blue: 0.25, alpha: 1)) // recording-red
            context.fillEllipse(in: CGRect(
                x: dotCenter.x - dotRadius,
                y: dotCenter.y - dotRadius,
                width: dotRadius * 2,
                height: dotRadius * 2
            ))
        }

        context.flush()
        return true
    }

    /// Draws a single CoreText line horizontally centered at the given
    /// baseline. Returns the drawn bounds (in context coordinates) or nil if
    /// the line was empty.
    @discardableResult
    private func drawCentered(text: String,
                              font: CTFont,
                              color: CGColor,
                              baselineY: CGFloat,
                              in context: CGContext,
                              canvasWidth: CGFloat) -> CGRect? {
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let line = CTLineCreateWithAttributedString(attributed)
        let bounds = CTLineGetBoundsWithOptions(line, [])
        guard bounds.width > 0 else { return nil }

        let x = (canvasWidth - bounds.width) / 2 - bounds.minX
        context.textPosition = CGPoint(x: x, y: baselineY)
        CTLineDraw(line, context)

        return CGRect(x: x + bounds.minX, y: baselineY + bounds.minY,
                      width: bounds.width, height: bounds.height)
    }
}
