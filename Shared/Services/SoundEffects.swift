import Foundation
import AVFoundation

/// Short UI chimes played between emails — a "finished" success sound and a
/// "next email" transition sound. Tones are generated in code (no bundled audio
/// files needed) and cached.
@MainActor
final class SoundEffects {

    static let shared = SoundEffects()

    enum Cue { case success, transition }

    private var players: [Cue: AVAudioPlayer] = [:]

    func play(_ cue: Cue) {
        // Make sure the playback session is active (we may be between utterances).
        SpeechAudioSession.activate()
        guard let player = player(for: cue) else { return }
        player.currentTime = 0
        player.play()
    }

    private func player(for cue: Cue) -> AVAudioPlayer? {
        if let cached = players[cue] { return cached }
        let data: Data
        switch cue {
        // Two ascending notes = "done".
        case .success: data = ToneGenerator.chime(notes: [(587, 0.12), (784, 0.20)])
        // One soft note = "here's the next one".
        case .transition: data = ToneGenerator.chime(notes: [(523, 0.14)])
        }
        guard let player = try? AVAudioPlayer(data: data) else { return nil }
        player.volume = 0.55
        player.prepareToPlay()
        players[cue] = player
        return player
    }
}

/// Generates short WAV chimes (16-bit PCM, mono) entirely in memory.
private enum ToneGenerator {
    static func chime(notes: [(frequency: Double, duration: Double)]) -> Data {
        let sampleRate = 44_100.0
        var samples: [Int16] = []
        for note in notes {
            let count = Int(sampleRate * note.duration)
            for i in 0..<count {
                let t = Double(i) / sampleRate
                // Quick attack (~5ms) then exponential decay, to avoid clicks.
                let attack = min(1.0, Double(i) / (0.005 * sampleRate))
                let decay = exp(-3.5 * t / note.duration)
                let value = sin(2 * .pi * note.frequency * t) * attack * decay * 0.6
                samples.append(Int16(max(-1, min(1, value)) * 32_767))
            }
        }
        return wav(samples: samples, sampleRate: Int(sampleRate))
    }

    private static func wav(samples: [Int16], sampleRate: Int) -> Data {
        var data = Data()
        let dataSize = samples.count * 2
        func put32(_ v: Int) { var x = UInt32(v).littleEndian; data.append(Data(bytes: &x, count: 4)) }
        func put16(_ v: Int) { var x = UInt16(v).littleEndian; data.append(Data(bytes: &x, count: 2)) }

        data.append("RIFF".data(using: .ascii)!); put32(36 + dataSize); data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!); put32(16); put16(1); put16(1) // PCM, mono
        put32(sampleRate); put32(sampleRate * 2); put16(2); put16(16)           // rates, align, bits
        data.append("data".data(using: .ascii)!); put32(dataSize)
        for sample in samples { var x = sample.littleEndian; data.append(Data(bytes: &x, count: 2)) }
        return data
    }
}
