import Foundation

/// A listener-created highlight: a snippet of what was just read, optionally
/// annotated with a note. Captured either by tapping the highlight button on
/// screen, by an AirPods press, or from the watch.
struct Highlight: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let emailID: String
    let emailSubject: String
    let createdAt: Date

    /// Playback position (seconds from the start of the email) at the moment of
    /// capture. Used to jump back to the spot.
    let audioOffset: TimeInterval

    /// Content-block index where the highlight was captured, so we can scroll
    /// the transcript to it and resume listening from there.
    let blockIndex: Int

    /// The text spoken in roughly the trailing `Highlight.lookbackWindow`
    /// seconds before capture.
    var capturedText: String

    /// Optional listener note.
    var note: String

    /// How far back a highlight reaches, in seconds.
    static let lookbackWindow: TimeInterval = 10

    init(id: UUID = UUID(),
         emailID: String,
         emailSubject: String,
         createdAt: Date = Date(),
         audioOffset: TimeInterval,
         blockIndex: Int = 0,
         capturedText: String,
         note: String = "") {
        self.id = id
        self.emailID = emailID
        self.emailSubject = emailSubject
        self.createdAt = createdAt
        self.audioOffset = audioOffset
        self.blockIndex = blockIndex
        self.capturedText = capturedText
        self.note = note
    }

    // Custom decoding so highlights saved before `blockIndex` existed still load.
    enum CodingKeys: String, CodingKey {
        case id, emailID, emailSubject, createdAt, audioOffset, blockIndex, capturedText, note
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        emailID = try c.decode(String.self, forKey: .emailID)
        emailSubject = try c.decode(String.self, forKey: .emailSubject)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        audioOffset = try c.decode(TimeInterval.self, forKey: .audioOffset)
        blockIndex = try c.decodeIfPresent(Int.self, forKey: .blockIndex) ?? 0
        capturedText = try c.decode(String.self, forKey: .capturedText)
        note = try c.decode(String.self, forKey: .note)
    }
}
