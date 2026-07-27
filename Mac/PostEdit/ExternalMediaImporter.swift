import Foundation
import AVFoundation
import UniformTypeIdentifiers
import os

/// Finds and runs the bundled ffmpeg helper.
///
/// Lifted out of `MediaImportService` unchanged so the podcast import path and
/// the editor's external-media path share one copy. `importTrack` keeps its
/// exact signature and delegates here.
enum FFmpegTool {
    enum Failure: Error, LocalizedError {
        case missing
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .missing:
                "The ffmpeg helper is missing. Add it to Contents/Helpers/ffmpeg — see docs/DEV_SETUP.md."
            case .failed(let message):
                "ffmpeg failed: \(message)"
            }
        }
    }

    /// Contents/Helpers/ffmpeg, falling back to Resources for dev builds where
    /// the copy phase isn't set up yet.
    static var executableURL: URL? {
        let bundle = Bundle.main.bundleURL
        let helpers = bundle.appendingPathComponent("Contents/Helpers/ffmpeg")
        if FileManager.default.fileExists(atPath: helpers.path) { return helpers }
        if let resource = Bundle.main.resourceURL?.appendingPathComponent("ffmpeg"),
           FileManager.default.fileExists(atPath: resource.path) {
            return resource
        }
        return nil
    }

    static func run(arguments: [String],
                    onProgressLine: ((String) -> Void)? = nil) async throws {
        guard let executable = executableURL else { throw Failure.missing }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            let outPipe = Pipe()
            let errPipe = Pipe()
            process.standardOutput = outPipe
            process.standardError = errPipe

            outPipe.fileHandleForReading.readabilityHandler = { handle in
                guard let line = String(data: handle.availableData, encoding: .utf8),
                      !line.isEmpty else { return }
                onProgressLine?(line)
            }
            process.terminationHandler = { proc in
                outPipe.fileHandleForReading.readabilityHandler = nil
                if proc.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    let data = errPipe.fileHandleForReading.readDataToEndOfFile()
                    let message = String(data: data, encoding: .utf8)?
                        .split(separator: "\n").suffix(4).joined(separator: "\n")
                        ?? "exit \(proc.terminationStatus)"
                    continuation.resume(throwing: Failure.failed(message))
                }
            }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
    }

    /// Seconds elapsed, parsed from an `-progress pipe:1` line, for a
    /// determinate progress bar.
    static func progressSeconds(from line: String) -> Double? {
        guard let range = line.range(of: "out_time_ms=") else { return nil }
        let digits = line[range.upperBound...].prefix { $0.isNumber }
        guard let micros = Double(digits) else { return nil }
        return micros / 1_000_000
    }
}

/// What a file turned out to be.
struct MediaProbe: Equatable, Sendable {
    var duration: Double
    var hasVideo: Bool
    var hasAudio: Bool
    var naturalSize: CGSize
    var isStill: Bool
}

/// Brings an arbitrary file on disk into the editor.
///
/// The fast path is the important one: a natively playable file is used
/// **where it is**, with no copy and no wait. Only containers AVFoundation
/// can't demux go through ffmpeg.
@MainActor
final class ExternalMediaImporter {
    enum Outcome: Equatable {
        case ready(MediaProbe)
        case needsTranscode(reason: String)
        case unreadable(reason: String)
        case protectedContent
    }

    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "externalmedia")

    /// Containers ffmpeg can usually rescue when AVFoundation can't open them.
    private static let transcodableExtensions: Set<String> =
        ["webm", "mkv", "avi", "flv", "wmv", "ogv", "ogg", "mpg", "mpeg", "ts", "m2ts"]

    // MARK: Probe

    func probe(_ url: URL) async -> Outcome {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .unreadable(reason: "The file no longer exists at that path.")
        }
        if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image) {
            // Stills have no tracks and no duration; they are still a legal
            // cutaway source.
            return .ready(MediaProbe(duration: 0, hasVideo: true, hasAudio: false,
                                     naturalSize: .zero, isStill: true))
        }

        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        do {
            if try await asset.load(.hasProtectedContent) {
                return .protectedContent
            }
            let playable = try await asset.load(.isPlayable)
            let video = try await asset.loadTracks(withMediaType: .video)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            let duration = try await asset.load(.duration).seconds

            guard playable, !(video.isEmpty && audio.isEmpty), duration.isFinite, duration > 0 else {
                return fallback(for: url)
            }
            let size = try await video.first?.load(.naturalSize) ?? .zero
            return .ready(MediaProbe(duration: duration,
                                     hasVideo: !video.isEmpty,
                                     hasAudio: !audio.isEmpty,
                                     naturalSize: size,
                                     isStill: false))
        } catch {
            log.error("probe failed for \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return fallback(for: url)
        }
    }

    /// AVFoundation doesn't cleanly distinguish "can't demux this container"
    /// from "corrupt file", so this is an honest heuristic rather than a
    /// pretence of certainty: a known ffmpeg-able extension is worth offering
    /// to convert; anything else is reported as unreadable.
    ///
    /// verify on Mac: `isPlayable` can return true for a container whose codec
    /// the OS cannot actually decode (VP9-in-MP4 on older systems is the
    /// classic). If that shows up, add a single-frame generator attempt here.
    private func fallback(for url: URL) -> Outcome {
        if Self.transcodableExtensions.contains(url.pathExtension.lowercased()) {
            return .needsTranscode(reason: "\(url.pathExtension.uppercased()) files need converting before they can be edited.")
        }
        return .unreadable(reason: "That file couldn't be opened. It may be corrupt, or in a format this app can't read.")
    }

    // MARK: Transcode

    /// Where converted media lives.
    ///
    /// Beside the project store, never a temp directory — a temp path produces
    /// a project that is broken tomorrow.
    static var mediaDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Streamit/Media", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    /// Converts to an edit-friendly `.mov`, reporting progress in 0…1.
    ///
    /// Deliberately not `MediaImportService.importTrack`: that path splits
    /// streams with `-vn`/`-an` because participant audio and video are
    /// separate `EditTrack`s. An external clip's audio and video are one clip
    /// and must stay in one file.
    func transcode(_ url: URL,
                   sourceDuration: Double?,
                   onProgress: @escaping (Double) -> Void) async throws -> URL {
        let output = Self.mediaDirectory
            .appendingPathComponent("\(UUID().uuidString).mov")

        var arguments = ["-y", "-hide_banner", "-nostdin", "-i", url.path]
        arguments += ["-c:v", "prores_ks", "-profile:v", "0"]
        arguments += ["-c:a", "pcm_s16le", "-ar", "48000"]
        arguments += ["-progress", "pipe:1", output.path]

        try await FFmpegTool.run(arguments: arguments) { line in
            guard let seconds = FFmpegTool.progressSeconds(from: line),
                  let total = sourceDuration, total > 0 else { return }
            Task { @MainActor in onProgress(min(1, seconds / total)) }
        }
        return output
    }
}
