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

    /// Optional hint of the content's dominant language (BCP-47 base, e.g. "he"),
    /// used to pick a matching voice when an individual chunk is too short to
    /// detect on its own. Engines that don't need it (cloud, multilingual) ignore it.
    var preferredLanguage: String? { get set }

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
        // Plain `.playback` (no mixing): VoiceInbox must interrupt other audio to
        // become the system "Now Playing" app — that's what puts it on the lock
        // screen / Control Center and routes the transport controls here. With a
        // mixing option like `.duckOthers`, iOS treats us as secondary audio and
        // leaves Now Playing with whatever app was already playing.
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.allowBluetoothA2DP])
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
    var preferredLanguage: String?

    private let voiceIdentifier: String
    private let synthesizer = AVSpeechSynthesizer()
    private var activeUtterance: AVSpeechUtterance?
    /// An utterance waiting for an in-flight `stopSpeaking` to land before it
    /// starts, so we never call `speak` in the same turn as a stop (which
    /// AVSpeechSynthesizer often drops, wedging playback).
    private var pendingUtterance: AVSpeechUtterance?

    init(voiceIdentifier: String) {
        self.voiceIdentifier = voiceIdentifier
        super.init()
        synthesizer.delegate = self
        // Route through our configured audio session so Now Playing / lock-screen
        // controls and AirPods work, and audio continues when the screen locks.
        synthesizer.usesApplicationAudioSession = true
    }

    func speak(_ text: String, speed: Double, pauseAfter: TimeInterval) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = Self.utteranceRate(for: speed)
        utterance.postUtteranceDelay = pauseAfter
        utterance.voice = voice(for: text)
        isPaused = false
        onWordRange?(nil)
        SpeechAudioSession.activate()

        if activeUtterance != nil || synthesizer.isSpeaking || synthesizer.isPaused {
            // Interrupting something: `stopSpeaking` is asynchronous, and calling
            // `speak` in the same turn frequently drops the new utterance. Stage
            // it and start once the cancel lands (`didCancel`), with a short
            // fallback in case the delegate doesn't fire.
            pendingUtterance = utterance
            activeUtterance = nil
            synthesizer.stopSpeaking(at: .immediate)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 80_000_000)
                guard let self, self.pendingUtterance === utterance else { return }
                self.startSpeaking(utterance)
            }
        } else {
            startSpeaking(utterance)
        }
    }

    private func startSpeaking(_ utterance: AVSpeechUtterance) {
        pendingUtterance = nil
        activeUtterance = utterance
        isPaused = false
        synthesizer.speak(utterance)
    }

    /// Pick a voice that matches the text's language. Uses the listener's chosen
    /// voice when it speaks that language; otherwise the best installed voice for
    /// the detected language (so e.g. Hebrew text is read by a Hebrew voice).
    private func voice(for text: String) -> AVSpeechSynthesisVoice? {
        let preferred = voiceIdentifier.isEmpty ? nil : AVSpeechSynthesisVoice(identifier: voiceIdentifier)
        // Use the email's dominant language as the authoritative choice. Detecting
        // each short block on its own is noisy — Hebrew in particular is often
        // misread as Yiddish (no voice -> silent English fallback) or as English
        // when a line has digits. Only detect per-chunk when there's no hint.
        guard let code = preferredLanguage ?? LanguageTools.languageCode(for: text) else { return preferred }
        if let preferred, preferred.language.hasPrefix(code) { return preferred }
        return Self.bestVoice(forLanguage: code) ?? preferred
    }

    /// Best-quality installed voice whose language matches `code` (e.g. "he").
    static func bestVoice(forLanguage code: String) -> AVSpeechSynthesisVoice? {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == code || $0.language.hasPrefix(code + "-") }
            .max { $0.quality.rawValue < $1.quality.rawValue }
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
        pendingUtterance = nil
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

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        // The interrupted utterance has actually stopped — now it's safe to start
        // the one staged in `speak`.
        Task { @MainActor in
            guard let pending = self.pendingUtterance else { return }
            self.startSpeaking(pending)
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
