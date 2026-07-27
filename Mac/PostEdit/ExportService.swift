import Foundation
import AVFoundation
import Observation
import os

/// Export paths out of the editor: podcast audio master, per-participant
/// stems, and the program video render (16:9 up to 4K or 9:16 vertical) with
/// optional burned captions — the same LayoutVideoCompositor as the preview,
/// so what you saw is what ships.
@MainActor
@Observable
final class ExportService {
    enum Target {
        case audioMaster(aac: Bool)          // WAV (false) or AAC .m4a (true)
        case stems
        case video(width: Int, height: Int, burnCaptions: Bool)
    }

    @Observable
    final class Job: Identifiable {
        let id = UUID()
        let title: String
        var fractionCompleted: Double = 0
        var finishedURL: URL?
        var error: String?
        fileprivate var session: AVAssetExportSession?

        init(title: String) {
            self.title = title
        }

        func cancel() {
            session?.cancelExport()
        }
    }

    private(set) var jobs: [Job] = []
    private let builder = CompositionBuilder()
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "export")

    private var exportsDirectory: URL {
        let url = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AVideos/Exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - Entry

    func export(project: EditProject, target: Target) {
        switch target {
        case .audioMaster(let aac):
            run(job: Job(title: "Audio master")) { [builder, exportsDirectory] job in
                let result = try await builder.build(project: project)
                let ext = aac ? "m4a" : "wav"
                let url = exportsDirectory.appendingPathComponent("\(project.name) master.\(ext)")
                try await Self.exportAudio(composition: result.composition,
                                           audioMix: result.audioMix,
                                           aac: aac, to: url, job: job)
                return url
            }
        case .stems:
            for track in project.tracks where track.kind == .audio {
                run(job: Job(title: "Stem — \(track.participantName)")) { [builder, exportsDirectory] job in
                    var solo = project
                    solo.tracks = [track]
                    var options = CompositionBuilder.Options()
                    options.includeVideo = false
                    // Keep the track's own level trim, but don't let a solo or
                    // mute set for monitoring silence the stem being written.
                    options.ignoresMuteAndSolo = true
                    // The project copy carries the overlays along, so without
                    // this a stem would silently gain cutaway audio and its
                    // ducking.
                    options.includesExternalMedia = false
                    let result = try await builder.build(project: solo, options: options)
                    let url = exportsDirectory.appendingPathComponent("\(project.name) — \(track.participantName).wav")
                    try await Self.exportAudio(composition: result.composition,
                                               audioMix: result.audioMix,
                                               aac: false, to: url, job: job)
                    return url
                }
            }
        case .video(let width, let height, let burnCaptions):
            run(job: Job(title: "Video \(width)×\(height)")) { [builder, exportsDirectory] job in
                var options = CompositionBuilder.Options()
                options.renderSize = CGSize(width: width, height: height)
                options.burnCaptions = burnCaptions
                let result = try await builder.build(project: project, options: options)
                let url = exportsDirectory.appendingPathComponent("\(project.name) \(width)x\(height).mp4")
                try await Self.exportVideo(composition: result.composition,
                                           audioMix: result.audioMix,
                                           videoComposition: result.videoComposition,
                                           chapters: project.chapters,
                                           to: url, job: job)
                // Caption sidecars ride along with video exports.
                if let transcript = project.transcript {
                    let editedWords = transcript.words.compactMap { word -> Word? in
                        guard let mapped = project.edl.mapSourceToTimeline(word.start) else { return nil }
                        var copy = word
                        let duration = word.end - word.start
                        copy.start = mapped
                        copy.end = mapped + duration
                        return copy
                    }
                    let lines = CaptionRenderer.lines(from: editedWords)
                    try? CaptionRenderer.srt(lines: lines)
                        .write(to: url.deletingPathExtension().appendingPathExtension("srt"),
                               atomically: true, encoding: .utf8)
                    try? CaptionRenderer.vtt(lines: lines)
                        .write(to: url.deletingPathExtension().appendingPathExtension("vtt"),
                               atomically: true, encoding: .utf8)
                }
                if !project.chapters.isEmpty {
                    try? ChapterGenerator.youtubeText(project.chapters)
                        .write(to: url.deletingPathExtension().appendingPathExtension("chapters.txt"),
                               atomically: true, encoding: .utf8)
                }
                return url
            }
        }
    }

    private func run(job: Job, _ work: @escaping (Job) async throws -> URL) {
        jobs.append(job)
        Task {
            do {
                job.finishedURL = try await work(job)
                job.fractionCompleted = 1
            } catch {
                job.error = error.localizedDescription
                log.error("Export failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Export sessions

    private static func exportAudio(composition: AVComposition,
                                    audioMix: AVAudioMix,
                                    aac: Bool,
                                    to url: URL,
                                    job: Job) async throws {
        try? FileManager.default.removeItem(at: url)
        // WAV needs passthrough-ish handling; AVAssetExportSession's
        // AppleM4A preset covers AAC. For WAV, export M4A-quality PCM via
        // the passthrough preset isn't available — use AVAssetReader/Writer.
        if aac {
            guard let session = AVAssetExportSession(asset: composition,
                                                     presetName: AVAssetExportPresetAppleM4A) else {
                throw NSError(domain: "ExportService", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "No audio export session"])
            }
            session.outputURL = url
            session.outputFileType = .m4a
            session.audioMix = audioMix
            job.session = session
            try await export(session: session, job: job)
        } else {
            try await exportWAV(composition: composition, audioMix: audioMix, to: url, job: job)
        }
    }

    private static func exportWAV(composition: AVComposition,
                                  audioMix: AVAudioMix,
                                  to url: URL,
                                  job: Job) async throws {
        let reader = try AVAssetReader(asset: composition)
        let output = AVAssetReaderAudioMixOutput(
            audioTracks: composition.tracks(withMediaType: .audio),
            audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
        output.audioMix = audioMix
        reader.add(output)

        let writer = try AVAssetWriter(outputURL: url, fileType: .wav)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        writer.add(input)

        guard writer.startWriting(), reader.startReading() else {
            throw writer.error ?? reader.error ?? NSError(domain: "ExportService", code: 2)
        }
        writer.startSession(atSourceTime: .zero)

        let duration = composition.duration.seconds
        let queue = DispatchQueue(label: "com.aviashkenazi.avideos.wav-export")
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            input.requestMediaDataWhenReady(on: queue) {
                while input.isReadyForMoreMediaData {
                    guard let sample = output.copyNextSampleBuffer() else {
                        input.markAsFinished()
                        continuation.resume()
                        return
                    }
                    input.append(sample)
                    if duration > 0 {
                        let progress = CMSampleBufferGetPresentationTimeStamp(sample).seconds / duration
                        Task { @MainActor in job.fractionCompleted = min(0.99, progress) }
                    }
                }
            }
        }
        await writer.finishWriting()
        if writer.status == .failed {
            throw writer.error ?? NSError(domain: "ExportService", code: 3)
        }
    }

    private static func exportVideo(composition: AVComposition,
                                    audioMix: AVAudioMix,
                                    videoComposition: AVVideoComposition?,
                                    chapters: [Chapter],
                                    to url: URL,
                                    job: Job) async throws {
        try? FileManager.default.removeItem(at: url)
        guard let session = AVAssetExportSession(asset: composition,
                                                 presetName: AVAssetExportPresetHighestQuality) else {
            throw NSError(domain: "ExportService", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "No video export session"])
        }
        session.outputURL = url
        session.outputFileType = .mp4
        session.audioMix = audioMix
        session.videoComposition = videoComposition
        // Chapter markers: QuickTime chapter tracks aren't authorable through
        // AVAssetExportSession; the .chapters.txt sidecar + YouTube text cover
        // v1 (yt-dlp/YouTube read description chapters; Podcasts apps read
        // sidecars). verify on Mac: revisit with AVAssetWriter metadata track.
        job.session = session
        try await export(session: session, job: job)
    }

    private static func export(session: AVAssetExportSession, job: Job) async throws {
        let progressTask = Task { @MainActor in
            while !Task.isCancelled {
                job.fractionCompleted = Double(session.progress)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { progressTask.cancel() }
        // verify on Mac: `await session.export()` is the async import of
        // exportAsynchronously(completionHandler:) and is available on
        // macOS 14 (the states-based export(to:as:) replacement is 15+).
        // session.progress/.error polling above is fine on 14, deprecated 15.
        await session.export()
        if let error = session.error {
            throw error
        }
    }
}
