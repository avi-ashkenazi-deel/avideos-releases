import Foundation
import Observation
import os

/// Local persistence and status tracking for podcast sessions:
/// `~/Library/Application Support/Streamit/Sessions/{id}/session.json` plus
/// media under `~/Movies/Streamit/Sessions/{id}/`.
@MainActor
@Observable
final class SessionLibraryStore {
    enum TrackStatus: Equatable {
        case recording
        case uploading(Double)      // guest still draining, fraction 0…1
        case ready                  // finalized remotely, not yet local
        case downloading(Double)
        case importing
        case imported(EditTrack)
        case failed(String)

        var displayText: String {
            switch self {
            case .recording: "Recording"
            case .uploading(let f): "Uploading \(Int(f * 100))%"
            case .ready: "Ready to download"
            case .downloading(let f): "Downloading \(Int(f * 100))%"
            case .importing: "Importing…"
            case .imported: "Imported"
            case .failed(let message): "Failed: \(message)"
            }
        }
    }

    struct TrackKey: Hashable {
        let sessionId: String
        let takeId: String
        let participantId: String
        let kind: TrackKind
    }

    private(set) var sessions: [RecordingSession] = []
    private(set) var trackStatus: [TrackKey: TrackStatus] = [:]

    private let importService = MediaImportService()
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "library")

    private var documentsDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Streamit/Sessions", isDirectory: true)
    }

    private func mediaDirectory(sessionId: String) -> URL {
        FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Streamit/Sessions/\(sessionId)", isDirectory: true)
    }

    init() {
        loadAll()
    }

    // MARK: - Persistence

    func loadAll() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let dirs = (try? FileManager.default.contentsOfDirectory(
            at: documentsDirectory, includingPropertiesForKeys: nil)) ?? []
        sessions = dirs.compactMap { dir in
            guard let data = try? Data(contentsOf: dir.appendingPathComponent("session.json")) else { return nil }
            return try? decoder.decode(RecordingSession.self, from: data)
        }
        .sorted { $0.createdAt > $1.createdAt }
    }

    func save(_ session: RecordingSession) {
        let dir = documentsDirectory.appendingPathComponent(session.id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(session) {
            try? data.write(to: dir.appendingPathComponent("session.json"), options: .atomic)
        }
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = session
        } else {
            sessions.insert(session, at: 0)
        }
    }

    func deleteSession(id: String) {
        try? FileManager.default.removeItem(at: documentsDirectory.appendingPathComponent(id))
        try? FileManager.default.removeItem(at: mediaDirectory(sessionId: id))
        sessions.removeAll { $0.id == id }
    }

    func storageBytes(sessionId: String) -> Int64 {
        let dir = mediaDirectory(sessionId: sessionId)
        guard let enumerator = FileManager.default.enumerator(
            at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }

    // MARK: - Download & import pipeline

    /// Downloads and imports every finalized track of a session; statuses
    /// stream into `trackStatus`. Returns the EditTracks that made it.
    func downloadAndImportAll(session: RecordingSession,
                              api: PodcastAPIClient) async -> [EditTrack] {
        let mediaDir = mediaDirectory(sessionId: session.id)
        let downloader = GuestTrackDownloader(api: api,
                                              sessionId: session.id,
                                              sessionDirectory: mediaDir)
        var imported: [EditTrack] = []

        for take in session.takes {
            for track in take.tracks {
                let key = TrackKey(sessionId: session.id, takeId: take.id,
                                   participantId: track.participantId, kind: track.kind)
                let name = session.participants.first { $0.id == track.participantId }?.displayName
                    ?? track.participantId

                do {
                    let rawURL: URL
                    if let local = track.localURL {
                        // Host tracks are already on disk.
                        rawURL = local
                    } else {
                        guard track.finalized else {
                            trackStatus[key] = .uploading(0)
                            continue
                        }
                        trackStatus[key] = .downloading(0)
                        rawURL = try await downloader.download(track: track, takeId: take.id) { [weak self] progress in
                            Task { @MainActor in
                                self?.trackStatus[key] = .downloading(progress.fraction)
                            }
                        }
                    }

                    trackStatus[key] = .importing
                    let editTrack = try await importService.importTrack(
                        rawURL: rawURL,
                        track: track,
                        takeId: take.id,
                        takeStartSessionMs: take.startedAtSession,
                        participantName: name,
                        sessionDirectory: mediaDir)
                    trackStatus[key] = .imported(editTrack)
                    imported.append(editTrack)
                } catch {
                    trackStatus[key] = .failed(error.localizedDescription)
                    log.error("Track \(track.participantId)/\(track.kind.rawValue) failed: \(error.localizedDescription)")
                }
            }
        }
        return imported
    }

    /// EditTracks already imported for a session (for "Open in Editor").
    func importedTracks(sessionId: String) -> [EditTrack] {
        trackStatus.compactMap { key, status in
            guard key.sessionId == sessionId else { return nil }
            if case .imported(let track) = status { return track }
            return nil
        }
    }
}
