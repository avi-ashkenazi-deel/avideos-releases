import Foundation

/// Shared podcast-mode session model — mirrors the Cloudflare Worker's
/// manifest shape (infra/worker/src/manifest.ts). These types are used by the
/// Podcast subsystem (recording/upload/import), the session library, and the
/// post-session editor.

enum TrackKind: String, Codable, Sendable {
    case audio
    case video
}

enum ParticipantRole: String, Codable, Sendable {
    case host
    case guest
}

struct RecordingSession: Codable, Sendable, Identifiable {
    var id: String
    var createdAt: Date
    var livekitRoom: String
    var participants: [SessionParticipant]
    var takes: [TakeRecord]
}

struct SessionParticipant: Codable, Sendable, Identifiable {
    /// == LiveKit identity.
    var id: String
    var displayName: String
    var role: ParticipantRole
}

/// One record-start → record-stop span within a session.
struct TakeRecord: Codable, Sendable, Identifiable {
    var id: String
    /// Session-clock milliseconds at the host's record-start broadcast.
    var startedAtSession: Double
    var tracks: [TrackRecord]
}

/// One participant's local media (audio or video) for one take.
struct TrackRecord: Codable, Sendable {
    var participantId: String
    var kind: TrackKind
    var anchor: ClockAnchor?
    var chunkCount: Int
    /// Sparse drift-fit samples: every Nth chunk's (mediaTime, sessionTime).
    var chunkTimeline: [ChunkStamp]
    var finalized: Bool
    var mimeType: String?
    var width: Int?
    var height: Int?
    /// Set after download + import on this Mac (not part of the manifest).
    var localURL: URL?
}

/// Media-time zero → session-clock mapping for one track.
struct ClockAnchor: Codable, Sendable {
    var mediaTimeMs: Double
    var sessionTimeMs: Double
    /// Estimated ± error of the clock-sync offset when anchored.
    var uncertaintyMs: Double
}

struct ChunkStamp: Codable, Sendable {
    var chunkIndex: Int
    var mediaTimeMs: Double
    var sessionTimeMs: Double
}

/// An imported, drift-corrected track ready for editing: t=0 == the take's
/// `startedAtSession` for every track, so composition building is pure
/// arithmetic. Produced by MediaImportService, consumed by the editor.
struct EditTrack: Codable, Sendable, Identifiable {
    var id: String
    var participantId: String
    var participantName: String
    var kind: TrackKind
    var url: URL
    var duration: Double
}
