import Foundation

#if os(iOS)
import MediaPlayer
import UIKit

/// Bridges hardware/transport controls (AirPods stem presses, Control Center,
/// the lock screen, CarPlay) to the player, and keeps Now Playing current —
/// including showing the email's current image as lock-screen artwork.
///
/// Note on AirPods: iOS doesn't let an app bind an arbitrary action to an
/// AirPods press; presses arrive as the standard transport commands. The player
/// decides what next/previous mean (see `bindRemoteCommands`): while an image is
/// showing, next *skips the image*; otherwise it can capture a highlight.
@MainActor
final class RemoteCommandController {

    var onTogglePlayPause: (() -> Void)?
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?

    private let center = MPRemoteCommandCenter.shared()
    /// Identifies the artwork currently wanted (first candidate URL); used to
    /// drop stale loads when the block/sender changes mid-fetch.
    private var artworkKey: String?
    private var loadingKey: String?
    private var artworkCache: [String: UIImage] = [:]

    func start() {
        // Clear any existing handlers first so re-binding doesn't stack duplicates.
        [center.togglePlayPauseCommand, center.playCommand, center.pauseCommand,
         center.nextTrackCommand, center.previousTrackCommand].forEach { $0.removeTarget(nil) }
        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.onTogglePlayPause?(); return .success }
        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in self?.onPlay?(); return .success }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in self?.onPause?(); return .success }
        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in self?.onNext?(); return .success }
        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in self?.onPrevious?(); return .success }
    }

    func stop() {
        [center.togglePlayPauseCommand, center.playCommand, center.pauseCommand,
         center.nextTrackCommand, center.previousTrackCommand].forEach { $0.removeTarget(nil) }
        clearNowPlaying()
    }

    /// Clear the lock-screen / Control Center entry without unbinding the
    /// transport commands (the single app-wide player keeps them bound).
    func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        artworkKey = nil
        loadingKey = nil
    }

    /// Reflect the current email in Now Playing. `imageCandidates` are tried in
    /// order (the email's own image when reading one, otherwise the sender's
    /// photo/logo); the app logo is shown until/if one loads.
    func updateNowPlaying(title: String, sender: String, isPlaying: Bool,
                          elapsed: TimeInterval, duration: TimeInterval,
                          imageCandidates: [URL]) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: sender,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPMediaItemPropertyPlaybackDuration: max(duration, 0.1),
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
        ]

        let key = imageCandidates.first?.absoluteString
        if let key, let cached = artworkCache[key] {
            info[MPMediaItemPropertyArtwork] = Self.artwork(from: cached)
        } else if let fallback = Self.defaultArtwork {
            info[MPMediaItemPropertyArtwork] = fallback
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // Setting the playback state explicitly is what reliably makes the
        // Lock Screen / Control Center transport controls appear.
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused

        loadArtwork(candidates: imageCandidates)
    }

    /// The app logo (asset named "AppLogo" if present) or a headphones glyph,
    /// shown when there's no sender/email image.
    private static let defaultArtwork: MPMediaItemArtwork? = {
        let image = UIImage(named: "AppLogo")
            ?? UIImage(systemName: "headphones",
                       withConfiguration: UIImage.SymbolConfiguration(pointSize: 256))
        guard let image else { return nil }
        return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }()

    private func loadArtwork(candidates: [URL]) {
        let key = candidates.first?.absoluteString
        artworkKey = key
        guard let key else { return }
        if artworkCache[key] != nil || loadingKey == key { return }
        loadingKey = key
        Task { [weak self] in
            var loaded: UIImage?
            for url in candidates {
                if let (data, response) = try? await URLSession.shared.data(from: url),
                   let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                   let image = UIImage(data: data) {
                    loaded = image
                    break
                }
            }
            guard let self else { return }
            if self.loadingKey == key { self.loadingKey = nil }
            // Only apply if this is still the artwork we want.
            guard let loaded, self.artworkKey == key else { return }
            self.artworkCache[key] = loaded
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPMediaItemPropertyArtwork] = Self.artwork(from: loaded)
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }
    }

    private static func artwork(from image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }
}

#else

/// watchOS has no MPRemoteCommandCenter; provide a no-op so shared callers compile.
@MainActor
final class RemoteCommandController {
    var onTogglePlayPause: (() -> Void)?
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?

    func start() {}
    func stop() {}
    func clearNowPlaying() {}
    func updateNowPlaying(title: String, sender: String, isPlaying: Bool,
                          elapsed: TimeInterval, duration: TimeInterval,
                          imageCandidates: [URL]) {}
}

#endif
