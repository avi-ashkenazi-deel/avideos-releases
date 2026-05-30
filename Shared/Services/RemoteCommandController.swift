import Foundation

#if os(iOS)
import MediaPlayer

/// Bridges hardware/transport controls (AirPods stem presses, Control Center,
/// the lock screen, and CarPlay) to the player, and keeps the Now Playing
/// info current.
///
/// Note on AirPods: iOS does not let an app bind an arbitrary action to an
/// AirPods press. Presses arrive as the standard transport commands
/// (play/pause, next/previous track). So when "highlight with AirPods" is
/// enabled we *repurpose* the next-track command to capture a highlight
/// instead of skipping. With it disabled, next-track skips to the next
/// sentence as usual.
@MainActor
final class RemoteCommandController {

    var onTogglePlayPause: (() -> Void)?
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onNextSentence: (() -> Void)?
    var onPreviousSentence: (() -> Void)?
    var onHighlight: (() -> Void)?

    /// When true, the next-track press captures a highlight instead of skipping.
    var airPodsHighlightEnabled = true

    private let center = MPRemoteCommandCenter.shared()

    func start() {
        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.onTogglePlayPause?(); return .success
        }
        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in self?.onPlay?(); return .success }

        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in self?.onPause?(); return .success }

        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.airPodsHighlightEnabled {
                self.onHighlight?()
            } else {
                self.onNextSentence?()
            }
            return .success
        }

        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.onPreviousSentence?(); return .success
        }
    }

    func stop() {
        center.togglePlayPauseCommand.removeTarget(nil)
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.nextTrackCommand.removeTarget(nil)
        center.previousTrackCommand.removeTarget(nil)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// Reflect the current email in Now Playing (lock screen, AirPods announce, etc.).
    func updateNowPlaying(title: String, sender: String, isPlaying: Bool,
                          elapsed: TimeInterval, duration: TimeInterval) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: sender,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPMediaItemPropertyPlaybackDuration: max(duration, 0.1),
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0
        ]
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

#else

/// watchOS has no MPRemoteCommandCenter; provide a no-op so shared callers compile.
@MainActor
final class RemoteCommandController {
    var onTogglePlayPause: (() -> Void)?
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onNextSentence: (() -> Void)?
    var onPreviousSentence: (() -> Void)?
    var onHighlight: (() -> Void)?
    var airPodsHighlightEnabled = true

    func start() {}
    func stop() {}
    func updateNowPlaying(title: String, sender: String, isPlaying: Bool,
                          elapsed: TimeInterval, duration: TimeInterval) {}
}

#endif
