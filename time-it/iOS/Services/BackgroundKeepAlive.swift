import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// Keeps the app alive in the background by playing a continuous *silent* audio
/// loop while timers are running. With the `audio` background mode + an active
/// playback session, iOS keeps the process scheduled, so the 0.1s tick keeps
/// firing and spoken/haptic cues (the countdown, interval announcements) play
/// live even with the screen locked — not just the fallback notifications.
///
/// The loop is true silence (a buffer of zeros), so it adds nothing audible and,
/// because the session mixes rather than ducks, the user's music is untouched.
@MainActor
final class BackgroundKeepAlive {
    #if canImport(AVFoundation) && !os(macOS)
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var prepared = false
    #endif
    private var running = false

    func start() {
        #if canImport(AVFoundation) && !os(macOS)
        guard !running else { return }
        AudioSession.activate()
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2),
              let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: AVAudioFrameCount(format.sampleRate))
        else { return }
        buffer.frameLength = buffer.frameCapacity   // zero-filled == silence

        if !prepared {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            prepared = true
        }
        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()
            running = true
        } catch {
            #if DEBUG
            print("BackgroundKeepAlive start failed: \(error)")
            #endif
        }
        #endif
    }

    func stop() {
        #if canImport(AVFoundation) && !os(macOS)
        guard running else { return }
        player.stop()
        engine.stop()
        #endif
        running = false
    }
}
