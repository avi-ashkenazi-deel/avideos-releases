import AppKit
import AVFoundation

/// A borderless window that sits on the desktop layer of one display — above
/// the system wallpaper, below the desktop icons — and loops a muted video.
///
/// macOS has no public "video wallpaper" setting, so this is how a moving
/// wallpaper is shown. The matching still image is always set as the real
/// wallpaper underneath, so Mission Control, the lock screen and the moment
/// before the video is ready all look right.
///
/// The window can show the whole video, or just this display's part of a
/// larger canvas that spans several displays (see `setGeometry`).
final class VideoWallpaperWindow: NSWindow {
    private let player = AVQueuePlayer()
    private let playerLayer = AVPlayerLayer()
    private var looper: AVPlayerLooper?
    private var readyObservation: NSKeyValueObservation?
    private(set) var videoURL: URL?

    /// Called on the main thread when the first frame of a video can be shown.
    var onReady: (() -> Void)?

    /// A convenience initialiser on purpose: the window keeps every
    /// initialiser `NSWindow` already has.
    convenience init(frame: CGRect) {
        self.init(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)

        DesktopLayer.configure(self)
        // Invisible until the first frame is ready, so there is never a black flash.
        alphaValue = 0

        player.isMuted = true
        player.actionAtItemEnd = .advance
        // Required for starting several players at one exact moment, and
        // right for local files anyway.
        player.automaticallyWaitsToMinimizeStalling = false
        // Every player follows the same clock, so players on different
        // displays cannot drift apart.
        player.sourceClock = CMClockGetHostTimeClock()
        // A wallpaper must never keep the display awake.
        player.preventsDisplaySleepDuringVideoPlayback = false
        player.allowsExternalPlayback = false

        playerLayer.player = player
        playerLayer.videoGravity = .resizeAspectFill

        // Layer-hosting view: a plain root layer that clips, with the video
        // layer inside it. The video layer may be larger than the window.
        let root = CALayer()
        root.masksToBounds = true
        root.addSublayer(playerLayer)
        let view = NSView(frame: CGRect(origin: .zero, size: frame.size))
        view.layer = root
        view.wantsLayer = true
        view.autoresizingMask = [.width, .height]
        contentView = view
        setGeometry(screenFrame: frame, canvas: nil)

        readyObservation = playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
            guard layer.isReadyForDisplay else { return }
            Task { @MainActor in
                self?.fadeIn()
                self?.onReady?()
            }
        }
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// `true` once the first frame of the current video can be shown.
    var isReady: Bool { playerLayer.isReadyForDisplay }

    /// Where the player is inside the current loop.
    var currentItemTime: CMTime {
        let time = player.currentTime()
        return time.isNumeric ? time : .zero
    }

    /// Places the window on its display and positions the video inside it.
    ///
    /// - Parameters:
    ///   - screenFrame: the display, in global desktop coordinates.
    ///   - canvas: the area the video should fill, in the same coordinates.
    ///     `nil` means "just this display". A canvas covering several
    ///     displays makes this window show only its own part of the video.
    func setGeometry(screenFrame: CGRect, canvas: CGRect?) {
        if frame != screenFrame {
            setFrame(screenFrame, display: true)
        }
        let videoFrame = DesktopLayer.pictureFrame(screenFrame: screenFrame, canvas: canvas)
        guard playerLayer.frame != videoFrame else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        playerLayer.frame = videoFrame
        CATransaction.commit()
    }

    /// Starts looping `url`, paused. Returns `false` if that video was
    /// already loaded and nothing changed.
    @discardableResult
    func load(_ url: URL) -> Bool {
        guard url != videoURL else { return false }
        videoURL = url
        alphaValue = 0
        looper?.disableLooping()
        player.pause()
        player.removeAllItems()
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        return true
    }

    func setPlaying(_ shouldPlay: Bool) {
        if shouldPlay {
            if player.rate == 0 { player.play() }
        } else if player.rate != 0 {
            player.pause()
        }
    }

    /// Starts playing so that the video is at `itemTime` at exactly
    /// `hostTime`. Giving several windows the same two values makes them
    /// play as one picture.
    func play(from itemTime: CMTime, atHostTime hostTime: CMTime) {
        player.setRate(1, time: itemTime, atHostTime: hostTime)
    }

    func tearDown() {
        readyObservation = nil
        onReady = nil
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
