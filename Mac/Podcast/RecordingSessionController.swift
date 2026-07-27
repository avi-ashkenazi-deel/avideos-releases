import Foundation
import Observation
import os

/// Orchestrates one podcast session end-to-end on the host: create the
/// session (LiveKit room + manifest), synchronize the session clock, run
/// takes (record-start/stop broadcast + host local recording), track guest
/// upload health from data-channel messages, and patch the manifest.
@MainActor
@Observable
final class RecordingSessionController {
    enum TakeState: Equatable {
        case idle
        case recording(takeId: String, startedAt: Date)
    }

    private(set) var session: RecordingSession?
    private(set) var takeState: TakeState = .idle
    private(set) var lastError: String?

    /// The host's local full-quality recorder — camera/mic taps feed it.
    private(set) var hostRecorder: HostLocalRecorder?
    private(set) var clock = SessionClock()

    /// Injected by StudioController: sends a JSON message over the LiveKit
    /// reliable data channel.
    var sendData: (([String: Any]) -> Void)?

    private var api: PodcastAPIClient?
    private var clockSync: ClockSyncService?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "podcast")

    var isTakeRunning: Bool {
        if case .recording = takeState { return true }
        return false
    }

    // MARK: - Session lifecycle

    /// Creates the backend session and starts clock sync. Returns the
    /// connection material for GuestSessionController.
    func createSession(baseURL: URL) async throws -> CreateSessionResponse {
        let client = try PodcastAPIClient(baseURL: baseURL)
        self.api = client

        let response = try await client.createSession()

        let sessionClock = SessionClock()
        let sync = ClockSyncService(clock: sessionClock) {
            try await client.serverTimeMs()
        }
        _ = try? await sync.syncOnce()
        sync.start()   // periodic resample
        self.clockSync = sync
        self.clock = sessionClock

        session = RecordingSession(id: response.sessionId,
                                   createdAt: Date(),
                                   livekitRoom: response.sessionId,
                                   participants: [
                                       SessionParticipant(id: "host", displayName: "Host", role: .host)
                                   ],
                                   takes: [])

        hostRecorder = HostLocalRecorder(sessionId: response.sessionId,
                                         hostParticipantId: "host",
                                         clock: clock)
        log.info("Session \(response.sessionId) created")
        return response
    }

    func endSession() {
        // Tearing down before stopTake() completes would no-op the stop
        // (stopTake guards on takeState) — guests would keep recording and
        // the host writers would never finalize. Stop first, then clean up.
        if isTakeRunning {
            Task {
                await stopTake()
                finishEndSession()
            }
        } else {
            finishEndSession()
        }
    }

    private func finishEndSession() {
        session = nil
        hostRecorder = nil
        api = nil
        clockSync?.stop()
        clockSync = nil
        takeState = .idle
    }

    // MARK: - Takes

    func startTake() {
        guard session != nil, !isTakeRunning else { return }
        let takeId = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10)).lowercased()
        let sessionTimeMs = clock.now()

        Task {
            do {
                try await hostRecorder?.start(takeId: takeId)
            } catch {
                lastError = "Host recording failed to start: \(error.localizedDescription)"
                log.error("Host recorder start failed: \(error.localizedDescription)")
            }
        }

        sendData?([
            "type": "record-start",
            "takeId": takeId,
            "sessionTimeMs": sessionTimeMs,
        ])

        let take = TakeRecord(id: takeId, startedAtSession: sessionTimeMs, tracks: [])
        session?.takes.append(take)
        takeState = .recording(takeId: takeId, startedAt: Date())

        // Register the take in the manifest.
        Task { [weak self] in
            guard let self, let api = self.api, let sessionId = self.session?.id else { return }
            _ = try? await api.patchManifest(
                sessionId: sessionId,
                patch: ManifestPatch(take: .init(id: takeId, startedAtSession: sessionTimeMs)),
                auth: .hostKey)
        }
    }

    func stopTake() async {
        guard case .recording(let takeId, _) = takeState else { return }
        takeState = .idle

        sendData?([
            "type": "record-stop",
            "takeId": takeId,
        ])

        do {
            let tracks = try await hostRecorder?.stop() ?? []
            if let index = session?.takes.firstIndex(where: { $0.id == takeId }) {
                session?.takes[index].tracks.append(contentsOf: tracks)
            }
            // Patch host track metadata into the manifest.
            if let api, let sessionId = session?.id {
                for track in tracks {
                    let patch = ManifestPatch(track: .init(takeId: takeId,
                                                           participantId: track.participantId,
                                                           kind: track.kind,
                                                           anchor: track.anchor,
                                                           chunkCount: track.chunkCount,
                                                           chunkTimeline: track.chunkTimeline,
                                                           finalized: track.finalized,
                                                           mimeType: track.mimeType,
                                                           width: track.width,
                                                           height: track.height))
                    _ = try? await api.patchManifest(sessionId: sessionId, patch: patch, auth: .hostKey)
                }
            }
        } catch {
            lastError = "Host recording didn't finalize: \(error.localizedDescription)"
            log.error("Host recorder stop failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Data channel

    /// Guest messages arrive here via GuestSessionController's mux. Guest
    /// upload-progress is applied to GuestParticipant models there; this
    /// controller only reacts to record-errors for surfacing.
    func handleDataMessage(_ json: [String: Any]) {
        guard let type = json["type"] as? String else { return }
        switch type {
        case "record-error":
            let who = json["participantId"] as? String ?? "guest"
            let message = json["message"] as? String ?? "unknown error"
            lastError = "\(who): \(message)"
        default:
            break
        }
    }

    // MARK: - Post-session

    /// Refreshes the session from the remote manifest (guest tracks appear
    /// as they finalize/upload). Local-only state — host track `localURL`s
    /// and the host participant row (which never joins via the worker) — is
    /// preserved across the replace, or downloads would be attempted for
    /// host tracks that were never uploaded.
    func refreshFromManifest() async {
        guard let api, let sessionId = session?.id, let current = session else { return }
        do {
            let remote = try await api.manifest(sessionId: sessionId)
            var refreshed = remote.toRecordingSession()

            for participant in current.participants
            where !refreshed.participants.contains(where: { $0.id == participant.id }) {
                refreshed.participants.append(participant)
            }

            for (takeIndex, take) in refreshed.takes.enumerated() {
                guard let localTake = current.takes.first(where: { $0.id == take.id }) else { continue }
                for (trackIndex, track) in take.tracks.enumerated() {
                    if track.localURL == nil,
                       let localURL = localTake.tracks.first(where: {
                           $0.participantId == track.participantId && $0.kind == track.kind
                       })?.localURL {
                        refreshed.takes[takeIndex].tracks[trackIndex].localURL = localURL
                    }
                }
            }

            session = refreshed
        } catch {
            log.error("Manifest refresh failed: \(error.localizedDescription)")
        }
    }
}
