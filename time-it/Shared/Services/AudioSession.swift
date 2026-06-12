import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// Configures the shared audio session for spoken cues. We *mix* with other
/// audio (the user's gym playlist) so it keeps playing and our voice plays over
/// it. We deliberately do NOT duck: while timers run we keep a silent keep-alive
/// track playing (so speech can fire in the background), and `.duckOthers` would
/// then hold the music down the entire time.
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
                    options: [.mixWithOthers, .allowBluetoothA2DP]
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
