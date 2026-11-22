import AppKit
import AVFoundation
import SceneryCore

/// Puts wallpapers on displays.
///
/// - Images go through the normal macOS wallpaper setting, one display at a time.
/// - Videos get the still set the same way, plus a `VideoWallpaperWindow` on top.
/// - A spanned video is one window per display, each showing its own part of
///   the picture, all started at the same instant so they move as one.
/// - Live wallpapers get a `LiveWallpaperWindow`, coloured for the Sun's
///   position (see `setSun`).
@MainActor
final class WallpaperEngine {
    struct Assignment: Equatable {
        /// What macOS shows as the wallpaper. For a spanned wallpaper this is
        /// already this display's slice of the picture.
        let stillURL: URL
        /// Set for video wallpapers that should actually play.
        let videoURL: URL?
        /// Set when the wallpaper spans several displays: the area, in global
        /// desktop coordinates, that the whole picture covers.
        let canvas: CGRect?
        /// Set for live wallpapers: the colours to draw through the day.
        let palette: DayPalette?
    }

    private var assignments: [String: Assignment] = [:]
    private var windows: [String: VideoWallpaperWindow] = [:]
    private var liveWindows: [String: LiveWallpaperWindow] = [:]
    /// Where the Sun is, for colouring live wallpapers.
    private var sun = SunPosition(elevation: 45, isRising: true)
    private var occlusionObserver: NSObjectProtocol?
    /// `true` while the windows of a spanned video are playing in step.
    private var isGroupPlaying = false

    /// `false` freezes every video (battery, low power, displays asleep…).
    var playbackAllowed = true {
        didSet { if oldValue != playbackAllowed { updatePlayback() } }
    }

    init() {
        // A video that nobody can see (covered by windows, or behind a
        // full-screen app) is paused, and resumes when the desktop shows again.
        occlusionObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard notification.object is VideoWallpaperWindow else { return }
            Task { @MainActor in self?.updatePlayback() }
        }
    }

    func assignment(forDisplay id: String) -> Assignment? {
        assignments[id]
    }

    /// Replaces the full set of assignments, keyed by display identifier.
    func apply(_ newAssignments: [String: Assignment]) {
        assignments = newAssignments
        let screens = Displays.screensByID()
        var groupChanged = false

        for (displayID, assignment) in newAssignments {
            guard let screen = screens[displayID] else { continue }
            setDesktopImage(assignment.stillURL, on: screen)

            if let videoURL = assignment.videoURL {
                let window: VideoWallpaperWindow
                if let existing = windows[displayID] {
                    window = existing
                } else {
                    window = VideoWallpaperWindow(frame: screen.frame)
                    window.onReady = { [weak self] in self?.updatePlayback() }
                    windows[displayID] = window
                    groupChanged = true
                }
                window.setGeometry(screenFrame: screen.frame, canvas: assignment.canvas)
                if window.load(videoURL) { groupChanged = true }
                window.orderFrontRegardless()
            } else if let window = windows.removeValue(forKey: displayID) {
                window.tearDown()
                groupChanged = true
            }

            if let palette = assignment.palette {
                let window = liveWindows[displayID] ?? LiveWallpaperWindow(frame: screen.frame)
                liveWindows[displayID] = window
                window.setGeometry(screenFrame: screen.frame, canvas: assignment.canvas)
                window.show(palette.colors(for: sun), transition: 0)
                window.orderFrontRegardless()
            } else {
                liveWindows.removeValue(forKey: displayID)?.tearDown()
            }
        }

        // Displays that were unplugged, or no longer have an assignment.
        for displayID in Array(windows.keys) where newAssignments[displayID] == nil || screens[displayID] == nil {
            windows.removeValue(forKey: displayID)?.tearDown()
            groupChanged = true
        }

        for displayID in Array(liveWindows.keys) where newAssignments[displayID] == nil || screens[displayID] == nil {
            liveWindows.removeValue(forKey: displayID)?.tearDown()
        }

        if groupChanged && isSpanning {
            // The set of players changed, so they have to be lined up again.
            pauseAll()
        }
        updatePlayback()
    }

    /// Recolours every live wallpaper for a new Sun position, fading over
    /// `transition` seconds.
    func setSun(_ newSun: SunPosition, transition: CFTimeInterval) {
        guard newSun != sun else { return }
        sun = newSun
        for (displayID, window) in liveWindows {
            guard let palette = assignments[displayID]?.palette else { continue }
            window.show(palette.colors(for: newSun), transition: transition)
        }
    }

    /// Sets the still wallpapers again. macOS keeps a separate wallpaper for
    /// every Space, so this runs when the active Space changes; it also
    /// quietly restores the approved wallpaper if it was changed by hand.
    func reassertStills() {
        let screens = Displays.screensByID()
        for (displayID, assignment) in assignments {
            guard let screen = screens[displayID] else { continue }
            setDesktopImage(assignment.stillURL, on: screen)
        }
    }

    func updatePlayback() {
        guard isSpanning else {
            // Independent videos: each window plays whenever it can be seen.
            isGroupPlaying = false
            for window in windows.values {
                window.setPlaying(playbackAllowed && window.occlusionState.contains(.visible))
            }
            return
        }

        // One picture across several displays: the windows play together or
        // not at all, so the picture can never tear at the seam.
        let anyVisible = windows.values.contains { $0.occlusionState.contains(.visible) }
        let allReady = windows.values.allSatisfy { $0.isReady }
        if playbackAllowed && anyVisible && allReady {
            if !isGroupPlaying { startTogether() }
        } else if isGroupPlaying || !allReady {
            pauseAll()
        }
    }

    // MARK: - Spanned playback

    /// `true` when a video is being shown as one picture across displays.
    private var isSpanning: Bool {
        windows.count > 1 && assignments.values.contains { $0.canvas != nil && $0.videoURL != nil }
    }

    private func pauseAll() {
        isGroupPlaying = false
        for window in windows.values {
            window.setPlaying(false)
        }
    }

    /// Starts every window from the same point in the loop at the same
    /// instant, a moment from now so each player has time to get ready.
    private func startTogether() {
        guard let reference = windows.values.first else { return }
        let itemTime = reference.currentItemTime
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let start = CMTimeAdd(now, CMTime(value: 15, timescale: 100))
        for window in windows.values {
            window.play(from: itemTime, atHostTime: start)
        }
        isGroupPlaying = true
    }

    // MARK: - Stills

    private func setDesktopImage(_ url: URL, on screen: NSScreen) {
        let workspace = NSWorkspace.shared
        if workspace.desktopImageURL(for: screen)?.standardizedFileURL == url.standardizedFileURL {
            return
        }
        let options: [NSWorkspace.DesktopImageOptionKey: Any] = [
            .imageScaling: NSNumber(value: NSImageScaling.scaleProportionallyUpOrDown.rawValue),
            .allowClipping: NSNumber(value: true),
        ]
        do {
            try workspace.setDesktopImageURL(url, for: screen, options: options)
        } catch {
            NSLog("Scenery: could not set wallpaper on %@: %@", screen.localizedName, error.localizedDescription)
        }
    }
}
