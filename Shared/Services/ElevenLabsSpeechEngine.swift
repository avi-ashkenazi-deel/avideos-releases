import Foundation
import AVFoundation

/// Speaks via the ElevenLabs cloud API: fetch MP3 for the chunk, then play it
/// with `AVAudioPlayer`. Speed is applied as a playback-rate multiplier.
///
/// There's no per-word timing here, so `onWordRange` always reports `nil`; the
/// player still highlights the whole active sentence.
@MainActor
final class ElevenLabsSpeechEngine: NSObject, SpeechEngine {

    var onFinish: ((Bool) -> Void)?
    var onWordRange: ((NSRange?) -> Void)?
    var onError: ((String) -> Void)?

    private(set) var isPaused = false

    private let client: ElevenLabsClient
    private let voiceID: String
    private var player: AVAudioPlayer?
    private var fetchTask: Task<Void, Never>?
    private var pendingPauseAfter: TimeInterval = 0

    init(client: ElevenLabsClient, voiceID: String) {
        self.client = client
        self.voiceID = voiceID
        super.init()
    }

    func speak(_ text: String, speed: Double, pauseAfter: TimeInterval) {
        stop()
        onWordRange?(nil)
        let clampedSpeed = Float(AppSettings.clampSpeed(speed))
        fetchTask = Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await client.synthesize(text: text, voiceID: voiceID)
                if Task.isCancelled { return }
                try self.startPlayback(data: data, rate: clampedSpeed, pauseAfter: pauseAfter)
            } catch is CancellationError {
                // Superseded by a newer request; ignore.
            } catch {
                self.onError?(error.localizedDescription)
                // Don't auto-advance on failure; leave the player stopped.
            }
        }
    }

    private func startPlayback(data: Data, rate: Float, pauseAfter: TimeInterval) throws {
        SpeechAudioSession.activate()
        let player = try AVAudioPlayer(data: data)
        player.enableRate = true
        player.rate = rate
        player.delegate = self
        self.player = player
        self.pendingPauseAfter = pauseAfter
        self.isPaused = false
        player.play()
    }

    func pause() {
        player?.pause()
        isPaused = true
    }

    func resume() {
        player?.play()
        isPaused = false
    }

    func stop() {
        fetchTask?.cancel()
        fetchTask = nil
        player?.stop()
        player = nil
        isPaused = false
    }
}

extension ElevenLabsSpeechEngine: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard player === self.player else { return }
            let delay = self.pendingPauseAfter
            self.player = nil
            if flag, delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
            self.onFinish?(flag)
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.onError?(error?.localizedDescription ?? "Audio decode error")
        }
    }
}
