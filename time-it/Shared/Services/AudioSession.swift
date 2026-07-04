import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// Configures the shared audio session for spoken cues.
///
/// On **iOS** we *mix* with other audio (the user's gym playlist) so it keeps
/// playing and our voice plays over it — we don't duck, because a silent
/// keep-alive track plays the whole time timers run and `.duckOthers` would then
/// hold the music down continuously.
///
/// On **watchOS** we must `.duckOthers` instead: with `.mixWithOthers` the watch
/// treats our audio as secondary and won't route spoken cues to the built-in
/// speaker when nothing else is playing — so the countdown voice was silent.
/// Ducking makes our speech the primary route; when no other audio is playing it
/// has no audible downside.
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
                #if os(watchOS)
                let options: AVAudioSession.CategoryOptions = [.duckOthers, .allowBluetoothA2DP]
                #else
                let options: AVAudioSession.CategoryOptions = [.mixWithOthers, .allowBluetoothA2DP]
                #endif
                try session.setCategory(.playback, mode: .spokenAudio, options: options)
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
