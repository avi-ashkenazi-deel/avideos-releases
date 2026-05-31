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
    private var artworkURL: URL?
    private var artworkCache: [URL: UIImage] = [:]

    func start() {
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
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        artworkURL = nil
    }

    /// Reflect the current email in Now Playing. When `imageURL` is non-nil
    /// (the player is on an image), it's loaded and shown as artwork so the
    /// image appears on the lock screen.
    func updateNowPlaying(title: String, sender: String, isPlaying: Bool,
                          elapsed: TimeInterval, duration: TimeInterval, imageURL: URL?) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: sender,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPMediaItemPropertyPlaybackDuration: max(duration, 0.1),
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
        ]

        if let imageURL {
            if let cached = artworkCache[imageURL] {
                info[MPMediaItemPropertyArtwork] = Self.artwork(from: cached)
            } else if let fallback = Self.defaultArtwork {
                info[MPMediaItemPropertyArtwork] = fallback
            }
            loadArtwork(from: imageURL)
        } else {
            artworkURL = nil
            if let fallback = Self.defaultArtwork {
                info[MPMediaItemPropertyArtwork] = fallback
            }
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // Setting the playback state explicitly is what reliably makes the
        // Lock Screen / Control Center transport controls appear.
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }

    /// A simple app glyph used when the email isn't showing an image.
    private static let defaultArtwork: MPMediaItemArtwork? = {
        let config = UIImage.SymbolConfiguration(pointSize: 256)
        guard let image = UIImage(systemName: "headphones", withConfiguration: config) else { return nil }
        return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }()

    private func loadArtwork(from url: URL) {
        artworkURL = url
        if artworkCache[url] != nil { return }
        Task { [weak self] in
            guard let (data, _) = try? await URLSession.shared.data(from: url),
                  let image = UIImage(data: data) else { return }
            guard let self, self.artworkURL == url else { return }
            self.artworkCache[url] = image
            // Merge artwork into the existing Now Playing info.
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPMediaItemPropertyArtwork] = Self.artwork(from: image)
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
    func updateNowPlaying(title: String, sender: String, isPlaying: Bool,
                          elapsed: TimeInterval, duration: TimeInterval, imageURL: URL?) {}
}

#endif
