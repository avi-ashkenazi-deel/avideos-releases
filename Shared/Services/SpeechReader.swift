import Foundation
import AVFoundation

/// A pluggable text-to-speech backend. The player drives whichever engine is
/// active (system voice or ElevenLabs) without caring which it is.
@MainActor
protocol SpeechEngine: AnyObject {
    /// Called when a chunk finishes. `finishedNaturally` is false when we
    /// stopped it ourselves (skip / new email / engine switch).
    var onFinish: ((_ finishedNaturally: Bool) -> Void)? { get set }
    /// Live word range within the current chunk (for on-screen underline).
    /// Engines that can't report word timing send `nil`.
    var onWordRange: ((NSRange?) -> Void)? { get set }
    /// Surface a user-facing problem (e.g. network/auth failure).
    var onError: ((String) -> Void)? { get set }

    var isPaused: Bool { get }

    func speak(_ text: String, speed: Double, pauseAfter: TimeInterval)
    func pause()
    func resume()
    func stop()
}

/// Shared audio-session setup for spoken playback so audio continues with the
/// screen locked and routes through AirPods.
enum SpeechAudioSession {
    static func activate() {
        let session = AVAudioSession.sharedInstance()
        #if os(watchOS)
        try? session.setCategory(.playback, mode: .spokenAudio)
        #else
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.allowBluetoothA2DP, .duckOthers])
        #endif
        try? session.setActive(true)
    }
}

/// On-device speech via `AVSpeechSynthesizer`. Reports the live word range so
/// the active word can be underlined on screen.
@MainActor
final class SystemSpeechEngine: NSObject, SpeechEngine {

    var onFinish: ((Bool) -> Void)?
    var onWordRange: ((NSRange?) -> Void)?
    var onError: ((String) -> Void)?

    private(set) var isPaused = false

    private let voiceIdentifier: String
    private let synthesizer = AVSpeechSynthesizer()
    private var activeUtterance: AVSpeechUtterance?

    init(voiceIdentifier: String) {
        self.voiceIdentifier = voiceIdentifier
        super.init()
        synthesizer.delegate = self
        // Route through our configured audio session so Now Playing / lock-screen
        // controls and AirPods work, and audio continues when the screen locks.
        synthesizer.usesApplicationAudioSession = true
    }

    func speak(_ text: String, speed: Double, pauseAfter: TimeInterval) {
        stop()
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = Self.utteranceRate(for: speed)
        utterance.postUtteranceDelay = pauseAfter
        if !voiceIdentifier.isEmpty, let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
            utterance.voice = voice
        }
        activeUtterance = utterance
        isPaused = false
        onWordRange?(nil)
        SpeechAudioSession.activate()
        synthesizer.speak(utterance)
    }

    func pause() {
        guard !isPaused, synthesizer.isSpeaking else { return }
        synthesizer.pauseSpeaking(at: .word)
        isPaused = true
    }

    func resume() {
        guard isPaused else { return }
        synthesizer.continueSpeaking()
        isPaused = false
    }

    func stop() {
        activeUtterance = nil
        isPaused = false
        onWordRange?(nil)
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    static func utteranceRate(for speed: Double) -> Float {
        let scaled = AVSpeechUtteranceDefaultSpeechRate * Float(AppSettings.clampSpeed(speed))
        return min(max(scaled, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }
}

extension SystemSpeechEngine: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in
            guard u === self.activeUtterance else { return }
            self.activeUtterance = nil
            self.isPaused = false
            self.onWordRange?(nil)
            self.onFinish?(true)
        }
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer,
                                       willSpeakRangeOfSpeechString range: NSRange,
                                       utterance u: AVSpeechUtterance) {
        Task { @MainActor in
            guard u === self.activeUtterance else { return }
            self.onWordRange?(range)
        }
    }
}
