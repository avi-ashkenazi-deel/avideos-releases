import Foundation
import CoreGraphics

/// Maps between the preview view's point space and unit canvas coordinates,
/// accounting for aspect-fit letterboxing. One instance per layout pass.
struct CanvasTransform {
    /// The rect (in view points) the canvas actually occupies.
    let canvasRect: CGRect

    init(viewSize: CGSize, canvasSize: CGSize) {
        guard viewSize.width > 0, viewSize.height > 0,
              canvasSize.width > 0, canvasSize.height > 0 else {
            canvasRect = .zero
            return
        }
        let viewAspect = viewSize.width / viewSize.height
        let canvasAspect = canvasSize.width / canvasSize.height
        if viewAspect > canvasAspect {
            // Pillarbox: full height.
            let width = viewSize.height * canvasAspect
            canvasRect = CGRect(x: (viewSize.width - width) / 2, y: 0,
                                width: width, height: viewSize.height)
        } else {
            // Letterbox: full width.
            let height = viewSize.width / canvasAspect
            canvasRect = CGRect(x: 0, y: (viewSize.height - height) / 2,
                                width: viewSize.width, height: height)
        }
    }

    func toUnit(_ point: CGPoint) -> CGPoint {
        guard canvasRect.width > 0, canvasRect.height > 0 else { return .zero }
        return CGPoint(x: (point.x - canvasRect.minX) / canvasRect.width,
                       y: (point.y - canvasRect.minY) / canvasRect.height)
    }

    func toView(_ unit: CGPoint) -> CGPoint {
        CGPoint(x: canvasRect.minX + unit.x * canvasRect.width,
                y: canvasRect.minY + unit.y * canvasRect.height)
    }

    /// View-space rect for an element transform (ignoring rotation — the
    /// selection chrome rotates via .rotationEffect).
    func viewRect(for transform: ElementTransform) -> CGRect {
        let center = toView(transform.center)
        let size = CGSize(width: transform.size.width * canvasRect.width,
                          height: transform.size.height * canvasRect.height)
        return CGRect(x: center.x - size.width / 2,
                      y: center.y - size.height / 2,
                      width: size.width,
                      height: size.height)
    }

    /// Delta in view points → delta in unit coords.
    func toUnitDelta(_ delta: CGSize) -> CGSize {
        guard canvasRect.width > 0, canvasRect.height > 0 else { return .zero }
        return CGSize(width: delta.width / canvasRect.width,
                      height: delta.height / canvasRect.height)
    }
}
