import Foundation
import AVFoundation
import Combine

/// Thin wrapper over `AVSpeechSynthesizer` that speaks one chunk of text at a
/// time and reports progress. The `EmailPlayerViewModel` drives it block by
/// block; this type only knows how to speak strings.
///
/// Works on iOS and watchOS. Configures the audio session for spoken playback
/// so it keeps going with the screen locked and routes through AirPods.
@MainActor
final class SpeechReader: NSObject, ObservableObject {

    /// True while audio is actively playing (not paused, not idle).
    @Published private(set) var isSpeaking = false
    /// True while paused mid-utterance.
    @Published private(set) var isPaused = false
    /// Character range of the word currently being spoken, within the active
    /// chunk — used to underline the live word on screen.
    @Published private(set) var spokenWordRange: NSRange?

    /// Called when an utterance ends. `finishedNaturally` is false when we
    /// stopped it ourselves (skip / new email / rate change).
    var onFinish: ((_ finishedNaturally: Bool) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    /// Guards against acting on the `didCancel`/`didFinish` of an utterance we've
    /// already abandoned.
    private var activeUtterance: AVSpeechUtterance?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    // MARK: - Audio session

    func activateAudioSession() {
        #if !os(watchOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.allowBluetoothA2DP, .duckOthers])
        try? session.setActive(true)
        #else
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        #endif
    }

    // MARK: - Speaking

    /// Speak `text`. `speed` is the friendly 0.5x...2.0x multiplier; `pauseAfter`
    /// is the trailing silence in seconds (0 when "remove silence" is on).
    func speak(_ text: String,
               speed: Double,
               voiceIdentifier: String,
               pauseAfter: TimeInterval) {
        stopInternal(notify: false)

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = Self.utteranceRate(for: speed)
        utterance.postUtteranceDelay = pauseAfter
        if !voiceIdentifier.isEmpty, let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
            utterance.voice = voice
        }

        activeUtterance = utterance
        isSpeaking = true
        isPaused = false
        spokenWordRange = nil
        activateAudioSession()
        synthesizer.speak(utterance)
    }

    func pause() {
        guard isSpeaking, !isPaused else { return }
        synthesizer.pauseSpeaking(at: .word)
        isPaused = true
        isSpeaking = false
    }

    func resume() {
        guard isPaused else { return }
        synthesizer.continueSpeaking()
        isPaused = false
        isSpeaking = true
    }

    /// Stop and notify nobody — used when the caller is about to start something new.
    func stop() {
        stopInternal(notify: false)
    }

    private func stopInternal(notify: Bool) {
        activeUtterance = nil
        spokenWordRange = nil
        isPaused = false
        isSpeaking = false
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    // MARK: - Rate mapping

    static func utteranceRate(for speed: Double) -> Float {
        let normal = AVSpeechUtteranceDefaultSpeechRate // ~0.5
        let scaled = normal * Float(AppSettings.clampSpeed(speed))
        return min(max(scaled, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }
}

extension SpeechReader: AVSpeechSynthesizerDelegate {

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                       didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard utterance === self.activeUtterance else { return }
            self.activeUtterance = nil
            self.isSpeaking = false
            self.isPaused = false
            self.spokenWordRange = nil
            self.onFinish?(true)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                       didCancel utterance: AVSpeechUtterance) {
        // We initiated the cancel; state is already reset in stopInternal. No-op.
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                       willSpeakRangeOfSpeechString characterRange: NSRange,
                                       utterance: AVSpeechUtterance) {
        Task { @MainActor in
            guard utterance === self.activeUtterance else { return }
            self.spokenWordRange = characterRange
        }
    }
}
