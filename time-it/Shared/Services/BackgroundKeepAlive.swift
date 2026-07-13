import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// Keeps the app alive in the background by looping a *silent* audio track while
/// timers run. With the `audio` background mode + an active playback session,
/// iOS keeps the process scheduled, so the 0.1s tick keeps firing and spoken /
/// haptic cues play live with the screen locked — not just the fallback
/// notifications.
///
/// We use `AVAudioPlayer` (not `AVAudioEngine`): the engine takes over the
/// output node and prevents `AVSpeechSynthesizer` from speaking, whereas an
/// `AVAudioPlayer` at zero volume mixes alongside speech without interfering.
@MainActor
final class BackgroundKeepAlive {
    #if canImport(AVFoundation) && !os(macOS)
    private var player: AVAudioPlayer?
    #endif

    func start() {
        #if canImport(AVFoundation) && !os(macOS)
        AudioSession.activate()
        if player == nil {
            player = try? AVAudioPlayer(data: Self.silentWAV())
            player?.numberOfLoops = -1   // loop forever
            player?.volume = 0            // truly silent
            player?.prepareToPlay()
        }
        player?.play()
        #endif
    }

    func stop() {
        #if canImport(AVFoundation) && !os(macOS)
        player?.stop()
        #endif
    }

    #if canImport(AVFoundation) && !os(macOS)
    /// A tiny in-memory silent PCM WAV (1s, 8 kHz mono) we can loop indefinitely.
    private static func silentWAV(seconds: Double = 1, sampleRate: Int = 8000) -> Data {
        let channels = 1, bits = 16
        let frames = Int(Double(sampleRate) * seconds)
        let dataSize = frames * channels * bits / 8
        var d = Data()
        func str(_ s: String) { d.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        str("RIFF"); u32(UInt32(36 + dataSize)); str("WAVE")
        str("fmt "); u32(16); u16(1); u16(UInt16(channels))
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * channels * bits / 8))
        u16(UInt16(channels * bits / 8)); u16(UInt16(bits))
        str("data"); u32(UInt32(dataSize))
        d.append(Data(count: dataSize))   // zeros == silence
        return d
    }
    #endif
}
