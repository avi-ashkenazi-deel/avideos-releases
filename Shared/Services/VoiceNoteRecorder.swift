import Foundation

#if os(iOS)
import Speech
import AVFoundation

/// Hands-free voice note capture: speaks a prompt, listens for a yes/no, and if
/// yes, records a spoken note and transcribes it on-device. Designed to run over
/// AirPods after a highlight is captured, so the listener never touches the screen.
///
/// Note: this needs real-device testing (mic routing through AirPods, and the
/// silence thresholds below may want tuning).
@MainActor
final class VoiceNoteRecorder: NSObject {

    enum Outcome {
        case declined          // user said no / stayed silent
        case note(String)      // dictated note text
        case unavailable       // permission denied or recognizer unavailable
    }

    private let synthesizer = AVSpeechSynthesizer()
    private let recognizer = SFSpeechRecognizer()
    private let audioEngine = AVAudioEngine()
    private var speakContinuation: CheckedContinuation<Void, Never>?

    override init() {
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
    }

    /// Run the full prompt → yes/no → dictate flow. Caller should pause playback
    /// first and restore the playback audio session afterwards.
    func captureNote() async -> Outcome {
        guard await authorize(), let recognizer, recognizer.isAvailable else {
            return .unavailable
        }
        configureSessionForRecording()

        await speak("Do you want to add a note?")
        let answer = await listen(maxSilence: 1.3, maxDuration: 5)
        guard Self.isAffirmative(answer) else {
            await speak("Okay.")
            return .declined
        }

        await speak("Go ahead.")
        let note = await listen(maxSilence: 2.0, maxDuration: 40)
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            await speak("I didn't catch that, so I didn't save a note.")
            return .declined
        }
        await speak("Note saved.")
        return .note(trimmed)
    }

    // MARK: - Permissions

    private func authorize() async -> Bool {
        let speech = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    private func configureSessionForRecording() {
        let session = AVAudioSession.sharedInstance()
        // playAndRecord + allowBluetooth routes the prompt to, and the mic from,
        // the AirPods.
        try? session.setCategory(.playAndRecord, mode: .spokenAudio,
                                 options: [.allowBluetooth, .defaultToSpeaker, .duckOthers])
        try? session.setActive(true)
    }

    // MARK: - Speaking

    private func speak(_ text: String) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            speakContinuation = cont
            let utterance = AVSpeechUtterance(string: text)
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            synthesizer.speak(utterance)
        }
    }

    // MARK: - Listening / recognition

    /// Holds mutable recognition state shared with off-main callbacks.
    private final class Session {
        var latest = ""
        var finished = false
        var silenceTimer: Timer?
        var task: SFSpeechRecognitionTask?
    }

    private func listen(maxSilence: TimeInterval, maxDuration: TimeInterval) async -> String {
        guard let recognizer else { return "" }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        // No usable mic route (e.g. triggered while the screen is locked) — bail
        // instead of installing a tap with an invalid format, which crashes
        // AVAudioEngine with a "channelCount > 0" assertion.
        guard format.channelCount > 0, format.sampleRate > 0 else { return "" }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        do { try audioEngine.start() } catch {
            input.removeTap(onBus: 0)
            return ""
        }

        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            let session = Session()

            let finish: () -> Void = { [weak self] in
                DispatchQueue.main.async {
                    guard !session.finished else { return }
                    session.finished = true
                    session.silenceTimer?.invalidate()
                    session.task?.cancel()
                    request.endAudio()
                    self?.audioEngine.stop()
                    self?.audioEngine.inputNode.removeTap(onBus: 0)
                    cont.resume(returning: session.latest)
                }
            }

            let armSilence: () -> Void = {
                DispatchQueue.main.async {
                    session.silenceTimer?.invalidate()
                    session.silenceTimer = Timer.scheduledTimer(withTimeInterval: maxSilence,
                                                                repeats: false) { _ in finish() }
                }
            }

            session.task = recognizer.recognitionTask(with: request) { result, error in
                if let result {
                    session.latest = result.bestTranscription.formattedString
                    armSilence()
                    if result.isFinal { finish() }
                }
                if error != nil { finish() }
            }

            // Hard cap regardless of speech.
            DispatchQueue.main.asyncAfter(deadline: .now() + maxDuration) { finish() }
            armSilence()
        }
    }

    private static func isAffirmative(_ text: String) -> Bool {
        let lower = text.lowercased()
        let no = ["no", "nope", "nah", "non", "nein", "لا", "לא"]
        let yes = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "please", "go ahead",
                   "definitely", "כן", "نعم", "oui", "sí", "ja", "sim"]
        if no.contains(where: { lower.contains($0) }) && !yes.contains(where: { lower.contains($0) }) {
            return false
        }
        return yes.contains { lower.contains($0) }
    }
}

extension VoiceNoteRecorder: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in
            self.speakContinuation?.resume()
            self.speakContinuation = nil
        }
    }
}

#else

/// watchOS has no on-device dictation flow here; provide a no-op.
@MainActor
final class VoiceNoteRecorder {
    enum Outcome { case declined, note(String), unavailable }
    func captureNote() async -> Outcome { .unavailable }
}

#endif
