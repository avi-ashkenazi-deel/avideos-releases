import Foundation
import os

/// Downloads a guest's chunked recording from R2 and concatenates it into a
/// raw WebM file. MediaRecorder timeslice chunks are a byte-split of one
/// continuous stream, so ordered byte concatenation reproduces a valid file
/// — no server-side stitching exists or is needed.
///
/// Resumable at chunk granularity: chunks already on disk are skipped.
final class GuestTrackDownloader {
    struct Progress {
        var downloadedChunks: Int
        var totalChunks: Int
        var fraction: Double { totalChunks > 0 ? Double(downloadedChunks) / Double(totalChunks) : 0 }
    }

    private let api: PodcastAPIClient
    private let sessionId: String
    private let sessionDirectory: URL
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "download")

    init(api: PodcastAPIClient, sessionId: String, sessionDirectory: URL) {
        self.api = api
        self.sessionId = sessionId
        self.sessionDirectory = sessionDirectory
    }

    /// Downloads + concatenates one track. Returns the raw .webm URL.
    func download(track: TrackRecord,
                  takeId: String,
                  onProgress: @escaping (Progress) -> Void) async throws -> URL {
        let prefix = "sessions/\(sessionId)/\(track.participantId)/\(takeId)/\(track.kind.rawValue)/"
        let listing = try await api.listDownloadKeys(sessionId: sessionId, prefix: prefix)
        // Chunk names are 6-digit zero-padded ("000042.webm", pad6 in
        // web/guest/recorder.js) so a lexicographic sort IS index order;
        // the sibling meta.json is excluded by the .webm filter.
        let chunkKeys = listing.keys
            .filter { $0.hasSuffix(".webm") }
            .sorted()

        guard !chunkKeys.isEmpty else {
            throw NSError(domain: "GuestTrackDownloader", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No uploaded chunks for \(track.participantId)/\(track.kind.rawValue)",
            ])
        }
        if track.finalized, track.chunkCount > 0, chunkKeys.count < track.chunkCount {
            log.warning("Track \(track.participantId)/\(track.kind.rawValue): \(chunkKeys.count)/\(track.chunkCount) chunks uploaded — proceeding with what's there")
        }

        let chunkDir = sessionDirectory
            .appendingPathComponent("chunks/\(track.participantId)-\(takeId)-\(track.kind.rawValue)", isDirectory: true)
        try FileManager.default.createDirectory(at: chunkDir, withIntermediateDirectories: true)

        // Presign + download in batches, skipping chunks already on disk.
        var downloaded = 0
        var progress = Progress(downloadedChunks: 0, totalChunks: chunkKeys.count)
        let batchSize = 50

        for batchStart in stride(from: 0, to: chunkKeys.count, by: batchSize) {
            let batch = Array(chunkKeys[batchStart..<min(batchStart + batchSize, chunkKeys.count)])
            let missing = batch.filter { key in
                !FileManager.default.fileExists(atPath: chunkDir.appendingPathComponent(Self.fileName(for: key)).path)
            }
            if !missing.isEmpty {
                let signed = try await api.signDownloads(sessionId: sessionId, keys: missing)
                let urlsByKey = Dictionary(signed.urls.map { ($0.key, $0.url) },
                                           uniquingKeysWith: { a, _ in a })
                for key in missing {
                    guard let urlString = urlsByKey[key], let url = URL(string: urlString) else { continue }
                    let destination = chunkDir.appendingPathComponent(Self.fileName(for: key))
                    let (tempURL, response) = try await URLSession.shared.download(from: url)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                        throw NSError(domain: "GuestTrackDownloader", code: 2, userInfo: [
                            NSLocalizedDescriptionKey: "Chunk download failed for \(key)",
                        ])
                    }
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: tempURL, to: destination)
                }
            }
            downloaded = min(batchStart + batch.count, chunkKeys.count)
            progress.downloadedChunks = downloaded
            onProgress(progress)
        }

        // Ordered byte concatenation → valid WebM.
        let rawDir = sessionDirectory.appendingPathComponent("raw", isDirectory: true)
        try FileManager.default.createDirectory(at: rawDir, withIntermediateDirectories: true)
        let output = rawDir.appendingPathComponent("\(track.participantId)-\(takeId)-\(track.kind.rawValue).webm")
        FileManager.default.createFile(atPath: output.path, contents: nil)
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        for key in chunkKeys {
            let chunkURL = chunkDir.appendingPathComponent(Self.fileName(for: key))
            let data = try Data(contentsOf: chunkURL)
            try handle.write(contentsOf: data)
        }
        log.info("Concatenated \(chunkKeys.count) chunks → \(output.lastPathComponent)")
        return output
    }

    private static func fileName(for key: String) -> String {
        key.components(separatedBy: "/").last ?? key
    }
}
