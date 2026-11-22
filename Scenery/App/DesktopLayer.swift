import AppKit

/// What every wallpaper window has in common: it sits on the desktop layer of
/// one display — above the system wallpaper, below the desktop icons and
/// widgets — on every Space, and never takes clicks or focus.
enum DesktopLayer {
    @MainActor
    static func configure(_ window: NSWindow) {
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.isExcludedFromWindowsMenu = true
        window.hidesOnDeactivate = false
        window.hasShadow = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.animationBehavior = .none
    }

    /// Where the picture goes inside a window that covers `screenFrame`.
    ///
    /// `canvas` is the area the whole picture fills, in global desktop
    /// coordinates; `nil` means "just this display". A canvas covering several
    /// displays makes each window show only its own part of the picture.
    /// Desktop coordinates and layer coordinates both start bottom-left, so
    /// the canvas only has to be shifted into the window's own space.
    static func pictureFrame(screenFrame: CGRect, canvas: CGRect?) -> CGRect {
        let target = canvas ?? screenFrame
        return CGRect(
            x: target.minX - screenFrame.minX,
            y: target.minY - screenFrame.minY,
            width: target.width,
            height: target.height
        )
    }
}
