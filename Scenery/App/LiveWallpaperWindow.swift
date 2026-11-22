import AppKit
import QuartzCore
import SceneryCore

/// A wallpaper that is drawn rather than played: one vertical gradient whose
/// colours are changed, slowly, as the day goes by.
///
/// It is the lightest kind of wallpaper there is. There is no file and no
/// decoding, and between colour changes (about once a minute) the window is
/// a static picture that costs nothing to keep on screen. Because it is drawn
/// to fit, it also spans any number of displays with no seam and nothing to
/// keep in sync.
final class LiveWallpaperWindow: NSWindow {
    private let gradientLayer = CAGradientLayer()

    /// A convenience initialiser on purpose: the window keeps every
    /// initialiser `NSWindow` already has.
    convenience init(frame: CGRect) {
        self.init(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        DesktopLayer.configure(self)

        // Unit coordinates start bottom-left on the Mac, so this runs from
        // the top of the picture to the bottom.
        gradientLayer.startPoint = CGPoint(x: 0.5, y: 1)
        gradientLayer.endPoint = CGPoint(x: 0.5, y: 0)

        // Layer-hosting view: a plain root layer that clips, with the
        // gradient inside it. The gradient may be larger than the window.
        let root = CALayer()
        root.masksToBounds = true
        root.addSublayer(gradientLayer)
        let view = NSView(frame: CGRect(origin: .zero, size: frame.size))
        view.layer = root
        view.wantsLayer = true
        view.autoresizingMask = [.width, .height]
        contentView = view
        setGeometry(screenFrame: frame, canvas: nil)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Places the window on its display and positions the gradient inside it.
    func setGeometry(screenFrame: CGRect, canvas: CGRect?) {
        if frame != screenFrame {
            setFrame(screenFrame, display: true)
        }
        let pictureFrame = DesktopLayer.pictureFrame(screenFrame: screenFrame, canvas: canvas)
        guard gradientLayer.frame != pictureFrame else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradientLayer.frame = pictureFrame
        CATransaction.commit()
    }

    /// Shows `colors` from top to bottom, fading from the current colours
    /// over `transition` seconds (0 changes them at once).
    func show(_ colors: [RGB], transition: CFTimeInterval) {
        let cgColors = colors.map {
            CGColor(srgbRed: CGFloat($0.red), green: CGFloat($0.green), blue: CGFloat($0.blue), alpha: 1)
        }
        CATransaction.begin()
        if transition > 0 {
            CATransaction.setAnimationDuration(transition)
        } else {
            CATransaction.setDisableActions(true)
        }
        gradientLayer.colors = cgColors
        CATransaction.commit()
    }

    func tearDown() {
        orderOut(nil)
        close()
    }
}
