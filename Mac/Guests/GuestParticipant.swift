import Foundation

/// UI-facing state for one connected remote guest.
@Observable
final class GuestParticipant: Identifiable {
    let identity: String
    var displayName: String
    var hasVideo: Bool = false
    var hasAudio: Bool = false
    var isMutedInMix: Bool = false
    /// Podcast-mode local-recording upload health, reported over the data
    /// channel every 5s while recording/draining.
    var uploadProgress: Double?
    var uploadQueuedChunks: Int = 0
    var isRecordingLocally: Bool = false
    var lastError: String?

    var id: String { identity }

    init(identity: String, displayName: String) {
        self.identity = identity
        self.displayName = displayName
    }

    var descriptor: GuestDescriptor {
        GuestDescriptor(identity: identity, displayName: displayName)
    }
}
