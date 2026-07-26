import Foundation
import AVFoundation
import os

/// Transcodes raw guest WebM (AVFoundation can't read WebM) and host .movs
/// into aligned, edit-ready .mov files via the bundled ffmpeg helper —
/// applying the TrackAligner retime in the same pass so every output shares
/// t=0 == the take start.
///
/// The ffmpeg binary is an LGPL build added on the Mac at
/// AVideosStudio.app/Contents/Helpers/ffmpeg (signed with hardened runtime
/// for notarization); a missing binary surfaces as a user-readable error,
/// never a crash.
final class MediaImportService {
    enum ImportError: LocalizedError {
        case ffmpegMissing
        case ffmpegFailed(String)

        var errorDescription: String? {
            switch self {
            case .ffmpegMissing:
                "The ffmpeg helper isn't bundled with this build — add it to Contents/Helpers (see docs/DEV_SETUP.md)."
            case .ffmpegFailed(let message):
                "Import failed: \(message)"
            }
        }
    }

    enum VideoImportQuality {
        case proResProxy    // edit-friendly
        case h264           // disk-friendly (CRF 18)
    }

    private let aligner: TrackAligning
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "import")

    init(aligner: TrackAligning = LinearDriftAligner()) {
        self.aligner = aligner
    }

    private var ffmpegURL: URL? {
        // Contents/Helpers/ffmpeg (preferred), falling back to Resources for
        // dev builds where the copy phase wasn't set up yet.
        let bundle = Bundle.main.bundleURL
        let helpers = bundle.appendingPathComponent("Contents/Helpers/ffmpeg")
        if FileManager.default.fileExists(atPath: helpers.path) { return helpers }
        if let resource = Bundle.main.resourceURL?.appendingPathComponent("ffmpeg"),
           FileManager.default.fileExists(atPath: resource.path) {
            return resource
        }
        return nil
    }

    /// Imports one raw file into an aligned .mov and returns the EditTrack.
    func importTrack(rawURL: URL,
                     track: TrackRecord,
                     takeId: String,
                     takeStartSessionMs: Double,
                     participantName: String,
                     sessionDirectory: URL,
                     videoQuality: VideoImportQuality = .proResProxy,
                     onProgressLine: ((String) -> Void)? = nil) async throws -> EditTrack {
        guard let ffmpeg = ffmpegURL else { throw ImportError.ffmpegMissing }

        let alignment = aligner.alignment(for: track, takeStartSessionMs: takeStartSessionMs)

        let importedDir = sessionDirectory.appendingPathComponent("imported", isDirectory: true)
        try FileManager.default.createDirectory(at: importedDir, withIntermediateDirectories: true)
        let output = importedDir.appendingPathComponent("\(track.participantId)-\(takeId)-\(track.kind.rawValue).mov")
        try? FileManager.default.removeItem(at: output)

        var args: [String] = ["-y", "-hide_banner", "-nostdin"]

        // Alignment: positive offset = the recording started AFTER the take
        // start → delay the stream (-itsoffset before -i); negative = it
        // started early → trim the head (-ss before -i).
        let offsetSeconds = alignment.offsetMs / 1000
        if offsetSeconds > 0.001 {
            args += ["-itsoffset", String(format: "%.3f", offsetSeconds)]
        } else if offsetSeconds < -0.001 {
            args += ["-ss", String(format: "%.3f", -offsetSeconds)]
        }
        args += ["-i", rawURL.path]

        switch track.kind {
        case .audio:
            // Drift retime via asetrate + aresample — exact for ppm-scale
            // corrections (atempo would resample audibly).
            let rate = alignment.rateFactor
            if abs(rate - 1.0) > 1e-6 {
                let assumedRate = 48_000.0 * rate
                args += ["-af", String(format: "asetrate=%.4f,aresample=48000", assumedRate)]
            } else {
                args += ["-ar", "48000"]
            }
            args += ["-c:a", "pcm_s16le", "-vn"]
        case .video:
            if abs(alignment.rateFactor - 1.0) > 1e-6 {
                // Scale frame PTS by the drift factor.
                args += ["-vf", String(format: "setpts=PTS*%.8f", 1.0 / alignment.rateFactor)]
            }
            switch videoQuality {
            case .proResProxy:
                args += ["-c:v", "prores_ks", "-profile:v", "0"]
            case .h264:
                args += ["-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p"]
            }
            args += ["-an"]
        }
        args += ["-progress", "pipe:1", output.path]

        try await run(ffmpeg: ffmpeg, arguments: args, onProgressLine: onProgressLine)

        // Probe duration for the editor.
        let asset = AVURLAsset(url: output)
        let duration = (try? await asset.load(.duration).seconds) ?? 0

        return EditTrack(id: "\(track.participantId)-\(takeId)-\(track.kind.rawValue)",
                         participantId: track.participantId,
                         participantName: participantName,
                         kind: track.kind,
                         url: output,
                         duration: duration)
    }

    private func run(ffmpeg: URL,
                     arguments: [String],
                     onProgressLine: ((String) -> Void)?) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = ffmpeg
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
                    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                    let message = String(data: errData, encoding: .utf8)?
                        .split(separator: "\n").suffix(4).joined(separator: "\n") ?? "exit \(proc.terminationStatus)"
                    continuation.resume(throwing: ImportError.ffmpegFailed(message))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}
