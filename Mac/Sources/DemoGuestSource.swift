import Foundation
import CoreGraphics
import CoreMedia
import CoreText
import Metal
import os

/// A synthetic guest feed for rehearsing multi-person layouts with nobody on
/// the call: an animated test card — tinted background, big initial, the
/// guest's name, and a bouncing dot so it reads as live video, not a still.
///
/// Registered under the same `.guest(identity:)` keys real guests use, so
/// interview grids, tiles, magic move and the layout picker all exercise the
/// exact code paths a real call would.
final class DemoGuestSource: FrameSource {
    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let mailbox = FrameMailbox()
    private let device: MTLDevice
    private let name: String
    /// 0…1 — spread across demo guests so each card has its own color.
    private let hue: CGFloat
    private var texture: MTLTexture?
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "com.aviashkenazi.streamit.demoguest",
                                      qos: .utility)
    private var tick = 0

    private let width = 640
    private let height = 360

    init(identity: String, name: String, hue: CGFloat, metalDevice: MTLDevice) {
        self.key = .guest(identity: identity)
        self.name = name
        self.hue = hue
        self.device = metalDevice
    }

    func start() {
        guard timer == nil else { return }
        state = .starting
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        descriptor.usage = [.shaderRead]
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            state = .failed("Could not allocate demo texture")
            return
        }
        self.texture = texture

        // 15 fps is plenty for a test card and costs nothing.
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / 15.0)
        t.setEventHandler { [weak self] in self?.renderFrame() }
        timer = t
        t.resume()
        state = .running
    }

    func stop() {
        timer?.cancel()
        timer = nil
        mailbox.clear()
        state = .idle
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        mailbox.latest()
    }

    private func renderFrame() {
        guard let texture else { return }
        tick += 1

        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &pixels,
                                  width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                  space: colorSpace,
                                  // BGRA byte order for the .bgra8Unorm texture.
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                      | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return }

        let w = CGFloat(width), h = CGFloat(height)
        let phase = Double(tick) / 15.0

        // Background: two tones of this guest's hue.
        ctx.setFillColor(color(hue: hue, saturation: 0.55, brightness: 0.35))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(color(hue: hue, saturation: 0.6, brightness: 0.45))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h * 0.42))

        // "Face": a big disc with the guest's initial.
        let disc = CGRect(x: w / 2 - 70, y: h / 2 - 55, width: 140, height: 140)
        ctx.setFillColor(color(hue: hue, saturation: 0.35, brightness: 0.85))
        ctx.fillEllipse(in: disc)
        draw(text: String(name.prefix(1)).uppercased(), size: 84,
             color: color(hue: hue, saturation: 0.7, brightness: 0.25),
             centeredAt: CGPoint(x: disc.midX, y: disc.midY - 30), in: ctx)

        // Name plate, bottom-left like a real lower third.
        draw(text: name, size: 26, color: CGColor(gray: 1, alpha: 0.95),
             centeredAt: CGPoint(x: w / 2, y: 28), in: ctx)

        // Motion: a dot orbiting the disc, so a frozen feed is obvious.
        let angle = phase * 1.6
        let dot = CGPoint(x: disc.midX + cos(angle) * 95, y: disc.midY + sin(angle) * 95)
        ctx.setFillColor(CGColor(gray: 1, alpha: 0.9))
        ctx.fillEllipse(in: CGRect(x: dot.x - 7, y: dot.y - 7, width: 14, height: 14))

        texture.replace(region: MTLRegionMake2D(0, 0, width, height),
                        mipmapLevel: 0, withBytes: pixels, bytesPerRow: bytesPerRow)
        mailbox.put(SourceFrame(pixelBuffer: nil,
                                texture: texture,
                                presentationTime: CMClockGetTime(CMClockGetHostTimeClock())))
    }

    private func color(hue: CGFloat, saturation: CGFloat, brightness: CGFloat) -> CGColor {
        // Small HSB→RGB so this file needs no AppKit.
        let c = brightness * saturation
        let hp = (hue * 6).truncatingRemainder(dividingBy: 6)
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let m = brightness - c
        let (r, g, b): (CGFloat, CGFloat, CGFloat)
        switch hp {
        case ..<1: (r, g, b) = (c, x, 0)
        case ..<2: (r, g, b) = (x, c, 0)
        case ..<3: (r, g, b) = (0, c, x)
        case ..<4: (r, g, b) = (0, x, c)
        case ..<5: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return CGColor(red: r + m, green: g + m, blue: b + m, alpha: 1)
    }

    private func draw(text: String, size: CGFloat, color: CGColor,
                      centeredAt point: CGPoint, in ctx: CGContext) {
        let font = CTFontCreateWithName("HelveticaNeue-Bold" as CFString, size, nil)
        let attributes: [CFString: Any] = [
            kCTFontAttributeName: font,
            kCTForegroundColorAttributeName: color,
        ]
        let attributed = CFAttributedStringCreate(nil, text as CFString,
                                                  attributes as CFDictionary)!
        let line = CTLineCreateWithAttributedString(attributed)
        let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
        ctx.textPosition = CGPoint(x: point.x - bounds.width / 2, y: point.y)
        CTLineDraw(line, ctx)
    }
}
