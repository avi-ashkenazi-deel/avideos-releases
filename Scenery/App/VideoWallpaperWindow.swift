import AppKit
import AVFoundation

/// A borderless window that sits on the desktop layer of one display — above
/// the system wallpaper, below the desktop icons — and loops a muted video.
///
/// macOS has no public "video wallpaper" setting, so this is how a moving
/// wallpaper is shown. The matching still image is always set as the real
/// wallpaper underneath, so Mission Control, the lock screen and the moment
/// before the video is ready all look right.
final class VideoWallpaperWindow: NSWindow {
    private let player = AVQueuePlayer()
    private let playerLayer = AVPlayerLayer()
    private var looper: AVPlayerLooper?
    private var readyObservation: NSKeyValueObservation?
    private(set) var videoURL: URL?

    /// A convenience initialiser on purpose: the window keeps every
    /// initialiser `NSWindow` already has.
    convenience init(frame: CGRect) {
        self.init(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)

        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        isReleasedWhenClosed = false
        ignoresMouseEvents = true
        isExcludedFromWindowsMenu = true
        hidesOnDeactivate = false
        hasShadow = false
        isOpaque = false
        backgroundColor = .clear
        animationBehavior = .none
        // Invisible until the first frame is ready, so there is never a black flash.
        alphaValue = 0

        player.isMuted = true
        player.actionAtItemEnd = .advance
        player.automaticallyWaitsToMinimizeStalling = false
        // A wallpaper must never keep the display awake.
        player.preventsDisplaySleepDuringVideoPlayback = false
        player.allowsExternalPlayback = false

        playerLayer.player = player
        playerLayer.videoGravity = .resizeAspectFill

        let view = NSView(frame: CGRect(origin: .zero, size: frame.size))
        // Layer-hosting: the layer is assigned before `wantsLayer`.
        view.layer = playerLayer
        view.wantsLayer = true
        view.autoresizingMask = [.width, .height]
        contentView = view

        readyObservation = playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
            guard layer.isReadyForDisplay else { return }
            Task { @MainActor in self?.fadeIn() }
        }
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Starts looping `url`. Does nothing if that video is already loaded.
    func load(_ url: URL) {
        guard url != videoURL else { return }
        videoURL = url
        alphaValue = 0
        looper?.disableLooping()
        player.removeAllItems()
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
    }

    func setPlaying(_ shouldPlay: Bool) {
        if shouldPlay {
            if player.rate == 0 { player.play() }
        } else if player.rate != 0 {
            player.pause()
        }
    }

    func tearDown() {
        readyObservation = nil
        looper?.disableLooping()
        looper = nil
        player.pause()
        player.removeAllItems()
        orderOut(nil)
        close()
    }

    private func fadeIn() {
        guard alphaValue < 1 else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.6
            animator().alphaValue = 1
        }
    }
}
