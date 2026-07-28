import Foundation
import CoreText
import CoreGraphics
import Metal
import AppKit

/// Rasterizes text elements into BGRA textures via CoreText, cached by
/// content hash — text re-renders only when the string/style/size changes,
/// never per frame.
final class TextRasterizer {
    private let device: MTLDevice
    private var cache: [Int: MTLTexture] = [:]
    private let lock = NSLock()

    init(device: MTLDevice) {
        self.device = device
    }

    /// Texture for the given text at the given pixel size. White glyphs on
    /// clear background — the compositor tints/paints via the item's fill,
    /// so colored, gradient, and video-filled text all share one raster.
    /// `canvasHeight` sets the font scale: `fontSize` is authored against a
    /// 1080p canvas, so the point size must track the canvas, not the element.
    func texture(for content: TextContent, pixelSize: CGSize, canvasHeight: CGFloat) -> MTLTexture? {
        var hasher = Hasher()
        hasher.combine(content)
        hasher.combine(Int(pixelSize.width))
        hasher.combine(Int(pixelSize.height))
        hasher.combine(Int(canvasHeight))
        let key = hasher.finalize()

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        guard let texture = rasterize(content, pixelSize: pixelSize, canvasHeight: canvasHeight)
        else { return nil }

        lock.lock()
        // Bound the cache; text variations are few in practice.
        if cache.count > 64 { cache.removeAll(keepingCapacity: true) }
        cache[key] = texture
        lock.unlock()
        return texture
    }

    private func rasterize(_ content: TextContent, pixelSize: CGSize,
                           canvasHeight: CGFloat) -> MTLTexture? {
        let width = max(2, Int(pixelSize.width))
        let height = max(2, Int(pixelSize.height))

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil,
                                  width: width,
                                  height: height,
                                  bitsPerComponent: 8,
                                  bytesPerRow: width * 4,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                      | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }

        ctx.clear(CGRect(x: 0, y: 0, width: width, height: height))

        // Font size is authored against a 1080p canvas, so it scales with the
        // CANVAS height. Scaling with the element's own height (the earlier
        // code) shrank a 64 pt title to ~8 px inside a default-height text box
        // — drawn, but invisible on screen.
        let scale = canvasHeight / 1080.0
        let fontSize = CGFloat(content.fontSize) * max(scale, 0.01)
        let font: NSFont = content.fontName.isEmpty
            ? NSFont.systemFont(ofSize: fontSize, weight: .semibold)
            : (NSFont(name: content.fontName, size: fontSize) ?? NSFont.systemFont(ofSize: fontSize))

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = content.lineSpacing
        switch content.alignment {
        case .leading: paragraph.alignment = .left
        case .center: paragraph.alignment = .center
        case .trailing: paragraph.alignment = .right
        }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ]
        let attributed = NSAttributedString(string: content.string, attributes: attributes)

        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        let path = CGPath(rect: bounds, transform: nil)
        // Vertically center: measure, then inset the frame path.
        let fitSize = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter, CFRange(location: 0, length: attributed.length), nil,
            CGSize(width: CGFloat(width), height: .greatestFiniteMagnitude), nil)
        let yInset = max(0, (CGFloat(height) - fitSize.height) / 2)
        let centeredPath = CGPath(rect: bounds.insetBy(dx: 0, dy: yInset), transform: nil)
        let frame = CTFramesetterCreateFrame(
            framesetter, CFRange(location: 0, length: attributed.length),
            yInset > 0 ? centeredPath : path, nil)

        CTFrameDraw(frame, ctx)

        guard let data = ctx.data else { return nil }
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        desc.usage = [.shaderRead]
        guard let texture = device.makeTexture(descriptor: desc) else { return nil }
        texture.replace(region: MTLRegionMake2D(0, 0, width, height),
                        mipmapLevel: 0,
                        withBytes: data,
                        bytesPerRow: width * 4)
        return texture
    }

    func drainCache() {
        lock.lock()
        cache.removeAll()
        lock.unlock()
    }
}
