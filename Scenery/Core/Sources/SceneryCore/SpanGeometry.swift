import Foundation

/// The arithmetic behind "one wallpaper stretched across every display".
///
/// All display rectangles are in the global desktop coordinate space that
/// macOS uses for arranging monitors: points, origin at the bottom-left,
/// y growing upwards. The arrangement people set in System Settings is what
/// decides how the picture flows from one display to the next.
public enum SpanGeometry {
    /// The single canvas that covers every display, or `nil` when there are
    /// fewer than two displays and there is nothing to span.
    public static func canvas(for displayFrames: [CGRect]) -> CGRect? {
        let usable = displayFrames.filter { $0.width > 0 && $0.height > 0 }
        guard usable.count > 1 else { return nil }
        return usable.dropFirst().reduce(usable[0]) { $0.union($1) }
    }

    /// Which part of an image one display shows when the image fills `canvas`
    /// edge to edge (cropping the overflow, never letterboxing).
    ///
    /// The result is in image pixels with the origin at the **top-left**, the
    /// convention used for cropping images.
    public static func cropRect(imageSize: CGSize, canvas: CGRect, display: CGRect) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, canvas.width > 0, canvas.height > 0 else {
            return CGRect(origin: .zero, size: imageSize)
        }
        // Points of canvas covered by one image pixel.
        let scale = max(canvas.width / imageSize.width, canvas.height / imageSize.height)
        // The scaled image is centred on the canvas; these are the (negative
        // or zero) offsets of its left and top edges from the canvas edges.
        let offsetX = (canvas.width - imageSize.width * scale) / 2
        let offsetY = (canvas.height - imageSize.height * scale) / 2

        let left = display.minX - canvas.minX
        let top = canvas.maxY - display.maxY

        let raw = CGRect(
            x: (left - offsetX) / scale,
            y: (top - offsetY) / scale,
            width: display.width / scale,
            height: display.height / scale
        )
        let rounded = CGRect(
            x: raw.minX.rounded(),
            y: raw.minY.rounded(),
            width: raw.width.rounded(),
            height: raw.height.rounded()
        )
        return rounded.intersection(CGRect(origin: .zero, size: imageSize))
    }
}
