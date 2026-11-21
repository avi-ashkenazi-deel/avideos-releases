import AppKit

/// Puts wallpapers on displays.
///
/// - Images go through the normal macOS wallpaper setting, one display at a time.
/// - Videos get the still set the same way, plus a `VideoWallpaperWindow` on top.
@MainActor
final class WallpaperEngine {
    struct Assignment: Equatable {
        /// What macOS shows as the wallpaper.
        let stillURL: URL
        /// Set for video wallpapers that should actually play.
        let videoURL: URL?
    }

    private var assignments: [String: Assignment] = [:]
    private var windows: [String: VideoWallpaperWindow] = [:]
    private var occlusionObserver: NSObjectProtocol?

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

        for (displayID, assignment) in newAssignments {
            guard let screen = screens[displayID] else { continue }
            setDesktopImage(assignment.stillURL, on: screen)

            if let videoURL = assignment.videoURL {
                let window = windows[displayID] ?? VideoWallpaperWindow(frame: screen.frame)
                windows[displayID] = window
                if window.frame != screen.frame {
                    window.setFrame(screen.frame, display: true)
                }
                window.load(videoURL)
                window.orderFrontRegardless()
            } else if let window = windows.removeValue(forKey: displayID) {
                window.tearDown()
            }
        }

        // Displays that were unplugged, or no longer have an assignment.
        for displayID in Array(windows.keys) where newAssignments[displayID] == nil || screens[displayID] == nil {
            windows.removeValue(forKey: displayID)?.tearDown()
        }
        updatePlayback()
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
        for window in windows.values {
            window.setPlaying(playbackAllowed && window.occlusionState.contains(.visible))
        }
    }

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
