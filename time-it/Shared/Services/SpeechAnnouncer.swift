import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

/// Speaks milestone phrases with `AVSpeechSynthesizer`, queuing utterances so
/// overlapping milestones (several timers firing at once) don't garble. Haptics
/// are delegated to `HapticPlayer` and fire immediately, in parallel with speech.
@MainActor
final class SpeechAnnouncer: NSObject, Announcer {

    /// Set false on the watch during a silent talk to suppress all speech while
    /// still allowing haptics through.
    var voiceEnabled: Bool = true

    /// Preferred speaking rate (0...1, AVSpeechUtterance scale).
    var rate: Float = AVSpeechUtteranceDefaultSpeechRate

    #if canImport(AVFoundation)
    private let synth = AVSpeechSynthesizer()
    #endif

    override init() {
        super.init()
        #if canImport(AVFoundation)
        synth.delegate = self
        // Respect the configured AudioSession (ducking/mixing) rather than
        // letting the synthesizer impose its own.
        #if !os(macOS)
        synth.usesApplicationAudioSession = true
        #endif
        #endif
    }

    func speak(_ text: String) {
        guard voiceEnabled, !text.isEmpty else { return }
        #if canImport(AVFoundation)
        AudioSession.activate()
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        // AVSpeechSynthesizer already queues utterances internally, so enqueuing
        // back-to-back plays them sequentially — exactly the no-overlap behavior
        // we want when multiple timers fire together.
        synth.speak(utterance)
        #endif
    }

    func haptic(_ pattern: HapticPattern) {
        HapticPlayer.play(pattern)
    }

    func timerCompleted(name: String, isFinalRepeat: Bool) {
        if isFinalRepeat {
            speak("\(name) complete")
            haptic(.timeUp)
        } else {
            // Between repeats: short cue only.
            haptic(.success)
        }
    }

    func stopSpeaking() {
        #if canImport(AVFoundation)
        synth.stopSpeaking(at: .immediate)
        #endif
    }
}

#if canImport(AVFoundation)
extension SpeechAnnouncer: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                       didFinish utterance: AVSpeechUtterance) {
        // When the queue drains we could deactivate the session, but timers are
        // usually still running so we leave it active to avoid duck/unduck churn.
    }
}
#endif
