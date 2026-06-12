import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// Configures the shared audio session for spoken cues. We *duck* other audio
/// (the user's gym playlist) rather than stopping it, and mix so the music keeps
/// playing between announcements.
///
/// `setCategory` is applied once (guarded) to avoid route re-negotiation glitches;
/// `setActive(true)` is safe to call repeatedly (e.g. after interruptions).
enum AudioSession {
    private static var configured = false

    static func configureForAnnouncements() {
        #if canImport(AVFoundation) && !os(macOS)
        let session = AVAudioSession.sharedInstance()
        if !configured {
            do {
                try session.setCategory(
                    .playback,
                    mode: .spokenAudio,
                    options: [.duckOthers, .mixWithOthers, .allowBluetoothA2DP]
                )
                configured = true
            } catch {
                // Non-fatal: speech will still attempt to play on the default session.
                #if DEBUG
                print("AudioSession setCategory failed: \(error)")
                #endif
            }
        }
        #endif
    }

    static func activate() {
        #if canImport(AVFoundation) && !os(macOS)
        configureForAnnouncements()
        try? AVAudioSession.sharedInstance().setActive(true, options: [])
        #endif
    }

    /// Let other audio return to full volume when no timers are running.
    static func deactivate() {
        #if canImport(AVFoundation) && !os(macOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        #endif
    }
}
