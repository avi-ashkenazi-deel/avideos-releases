import Foundation
import os
#if canImport(WhisperKit)
import WhisperKit
#endif

/// Engine seam so cloud transcription can slot in later; v1 ships WhisperKit
/// (on-device CoreML Whisper — free, private, word-level timestamps).
protocol TranscriptionEngine {
    /// Transcribes one single-speaker audio file; word times are file-local
    /// seconds (the caller maps to the common timeline — tracks share t=0,
    /// so it's the identity here).
    func transcribe(audioURL: URL,
                    trackId: String,
                    onProgress: @escaping (Double) -> Void) async throws -> [Word]
}

/// User-tunable disfluency vocabulary; matched case-insensitively after
/// punctuation stripping.
enum DisfluencyLexicon {
    static var words: Set<String> = ["um", "uh", "erm", "uhm", "hmm", "mmm", "err", "ah", "eh"]

    static func isDisfluency(_ token: String) -> Bool {
        words.contains(token.lowercased().trimmingCharacters(in: .punctuationCharacters))
    }
}

/// Transcribes every audio track of a session and interleaves the per-track
/// results into one Transcript ordered by time (speaker == track, so
/// diarization is free).
final class TranscriptionService {
    private let engine: TranscriptionEngine
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "transcription")

    init(engine: TranscriptionEngine = WhisperKitEngine()) {
        self.engine = engine
    }

    func transcribe(tracks: [EditTrack],
                    onProgress: @escaping (String, Double) -> Void) async throws -> Transcript {
        var allWords: [Word] = []
        for track in tracks where track.kind == .audio {
            let words = try await engine.transcribe(audioURL: track.url, trackId: track.id) { fraction in
                onProgress(track.participantName, fraction)
            }
            allWords.append(contentsOf: words)
        }
        allWords.sort { $0.start < $1.start }
        return Transcript(words: allWords, language: "en")
    }
}

/// WhisperKit adapter. Model: large-v3-turbo (best quality/speed on Apple
/// silicon), automatic download on first use; `base` fallback for old or
/// low-RAM machines.
final class WhisperKitEngine: TranscriptionEngine {
    var modelName = "large-v3-turbo"
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "whisper")

    func transcribe(audioURL: URL,
                    trackId: String,
                    onProgress: @escaping (Double) -> Void) async throws -> [Word] {
        // verify on Mac: WhisperKit API surface for the pinned release —
        // WhisperKit(WhisperKitConfig(model:)), transcribe(audioPath:decodeOptions:)
        // with DecodingOptions(wordTimestamps: true), results carrying
        // segments[].words[] with .word/.start/.end/.probability.
        #if canImport(WhisperKit)
        let whisper = try await WhisperKit(model: modelName)
        onProgress(0.1)
        let results = try await whisper.transcribe(
            audioPath: audioURL.path,
            decodeOptions: .init(wordTimestamps: true))
        onProgress(0.95)

        var words: [Word] = []
        for result in results {
            for segment in result.segments {
                for timing in segment.words ?? [] {
                    let text = timing.word.trimmingCharacters(in: .whitespaces)
                    guard !text.isEmpty else { continue }
                    words.append(Word(text: text,
                                      start: Double(timing.start),
                                      end: Double(timing.end),
                                      confidence: Double(timing.probability),
                                      trackId: trackId,
                                      isDisfluency: DisfluencyLexicon.isDisfluency(text)))
                }
            }
        }
        onProgress(1)
        return words
        #else
        // Linux/CI builds compile without WhisperKit; the Mac target links it.
        throw NSError(domain: "WhisperKitEngine", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "WhisperKit is unavailable in this build",
        ])
        #endif
    }
}
