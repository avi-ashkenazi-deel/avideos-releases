import Foundation
import CoreGraphics

/// Derives where a horizontally-designed element goes on the vertical (9:16)
/// canvas, so every scene has a sensible vertical version with zero extra
/// work. The host overrides any element by moving it in vertical edit mode
/// (`Element.verticalTransform`); this is only the default.
///
/// Element transforms are unit fractions of their canvas, so reusing them
/// verbatim on a 1080×1920 canvas STRETCHES every box (a circle becomes a
/// tall oval, a lower third becomes a narrow tower). The rules here keep the
/// element's PIXEL aspect instead:
///
/// - Full-canvas items (backgrounds, full-frame web pages) stay full-canvas.
/// - Everything else scales uniformly: about 1.6× its share of the canvas
///   width (a half-width lower third becomes ~80% of the phone's width),
///   never wider than 90% or taller than 70% of the vertical canvas.
/// - Horizontal position is kept, then clamped inside the edges; vertical
///   position is mapped into the title-safe band (12%–80% down) that stays
///   clear of the platform UI phones draw over the bottom of a vertical
///   stream.
///
/// Pure value code — unit-tested in `VerticalAdapterTests`.
enum VerticalAdapter {
    struct Result: Equatable {
        var transform: ElementTransform
        /// Uniform pixel scale from the horizontal design to vertical: text
        /// and strokes multiply by this so they shrink/grow with their box.
        var contentScale: Double
    }

    static let widthBoost = 1.6
    static let maxWidthFraction = 0.9
    static let maxHeightFraction = 0.7
    static let edgeMargin = 0.05
    static let safeTop = 0.12
    static let safeBottom = 0.80

    static func adapt(_ transform: ElementTransform,
                      from horizontal: CGSize,
                      to vertical: CGSize) -> Result {
        guard horizontal.width > 0, horizontal.height > 0,
              vertical.width > 0, vertical.height > 0 else {
            return Result(transform: transform, contentScale: 1)
        }

        // Full-canvas: stays full-canvas; content scales by the width ratio
        // (a full-frame title keeps fitting across).
        if transform.size.width >= 0.95, transform.size.height >= 0.95 {
            return Result(transform: transform,
                          contentScale: Double(vertical.width / horizontal.width))
        }

        let pixelWidth = Double(transform.size.width * horizontal.width)
        let pixelHeight = Double(transform.size.height * horizontal.height)
        guard pixelWidth > 0, pixelHeight > 0 else {
            return Result(transform: transform, contentScale: 1)
        }

        // Uniform scale: the boosted width share, capped by both limits.
        let targetWidth = min(Double(transform.size.width) * widthBoost, maxWidthFraction)
            * Double(vertical.width)
        var scale = targetWidth / pixelWidth
        scale = min(scale, maxWidthFraction * Double(vertical.width) / pixelWidth)
        scale = min(scale, maxHeightFraction * Double(vertical.height) / pixelHeight)

        let width = pixelWidth * scale / Double(vertical.width)
        let height = pixelHeight * scale / Double(vertical.height)

        // Horizontal: keep the relative position, keep it on the canvas.
        let halfWidth = width / 2
        let minX = edgeMargin + halfWidth
        let maxX = 1 - edgeMargin - halfWidth
        let x = minX <= maxX ? min(max(Double(transform.center.x), minX), maxX) : 0.5

        // Vertical: map 0…1 into the safe band, keep the box inside it.
        let halfHeight = height / 2
        let mapped = safeTop + Double(transform.center.y) * (safeBottom - safeTop)
        let minY = safeTop + halfHeight
        let maxY = safeBottom - halfHeight
        let y = minY <= maxY ? min(max(mapped, minY), maxY) : (safeTop + safeBottom) / 2

        var adapted = transform
        adapted.center = CGPoint(x: x, y: y)
        adapted.size = CGSize(width: width, height: height)
        return Result(transform: adapted, contentScale: scale)
    }

    /// The content scale implied by an explicit vertical override: how much
    /// bigger (in pixels) its box is than the horizontal original, by width.
    static func contentScale(horizontal: ElementTransform,
                             vertical: ElementTransform,
                             horizontalCanvas: CGSize,
                             verticalCanvas: CGSize) -> Double {
        let horizontalWidth = Double(horizontal.size.width * horizontalCanvas.width)
        guard horizontalWidth > 0 else { return 1 }
        return Double(vertical.size.width * verticalCanvas.width) / horizontalWidth
    }
}

extension InterviewLayout {
    /// Tile frames for a TALL canvas. The horizontal layouts put people side
    /// by side, which on 9:16 means tall slivers and cropped faces; these
    /// stack them instead.
    static func verticalFrames(count: Int,
                               style: InterviewSceneConfig.GridStyle,
                               spacing: Double) -> [ElementTransform] {
        guard count > 0 else { return [] }
        guard count > 1 else { return [.fullCanvas] }
        switch style {
        case .grid:
            // One column up to three people, two columns beyond.
            let columns = count <= 3 ? 1 : 2
            let rows = Int(ceil(Double(count) / Double(columns)))
            let cellW = (1.0 - spacing * Double(columns + 1)) / Double(columns)
            let cellH = (1.0 - spacing * Double(rows + 1)) / Double(rows)
            return (0..<count).map { index in
                let column = index % columns
                let row = index / columns
                let itemsInRow = row == rows - 1 ? count - row * columns : columns
                let rowWidth = Double(itemsInRow) * cellW + Double(itemsInRow - 1) * spacing
                let xStart = (1.0 - rowWidth) / 2
                return ElementTransform(
                    center: CGPoint(x: xStart + Double(column) * (cellW + spacing) + cellW / 2,
                                    y: spacing + Double(row) * (cellH + spacing) + cellH / 2),
                    size: CGSize(width: cellW, height: cellH))
            }
        case .hostLeading, .spotlight:
            // The lead (host or shared screen) on top, everyone else in a
            // grid below.
            let mainH = 0.55
            var frames = [ElementTransform(center: CGPoint(x: 0.5, y: spacing + mainH / 2),
                                           size: CGSize(width: 1.0 - spacing * 2, height: mainH))]
            let others = count - 1
            let columns = others <= 2 ? others : 2
            let rows = Int(ceil(Double(others) / Double(columns)))
            let areaTop = spacing * 2 + mainH
            let areaH = 1.0 - areaTop - spacing
            let cellW = (1.0 - spacing * Double(columns + 1)) / Double(columns)
            let cellH = (areaH - spacing * Double(rows - 1)) / Double(rows)
            for index in 0..<others {
                let column = index % columns
                let row = index / columns
                let itemsInRow = row == rows - 1 ? others - row * columns : columns
                let rowWidth = Double(itemsInRow) * cellW + Double(itemsInRow - 1) * spacing
                let xStart = (1.0 - rowWidth) / 2
                frames.append(ElementTransform(
                    center: CGPoint(x: xStart + Double(column) * (cellW + spacing) + cellW / 2,
                                    y: areaTop + Double(row) * (cellH + spacing) + cellH / 2),
                    size: CGSize(width: cellW, height: cellH)))
            }
            return frames
        }
    }
}
