import Foundation

/// A clip bolted onto one end of the program, outside the conversation.
struct BookendClip: Codable, Sendable, Equatable {
    var media: MediaReference
    /// Trim inside the file. **Stored**, not probed: `programOffset` is read on
    /// the main thread every frame by the timeline and the preview, so it must
    /// not require opening an asset.
    var sourceRange: ClosedRange<Double>
    var audio: ExternalAudio

    init(media: MediaReference,
         sourceRange: ClosedRange<Double>,
         audio: ExternalAudio = ExternalAudio(isEnabled: true, gainDB: 0, ducking: nil)) {
        self.media = media
        self.sourceRange = sourceRange
        self.audio = audio
    }

    var duration: Double { sourceRange.upperBound - sourceRange.lowerBound }
}

struct ProgramBookends: Codable, Sendable, Equatable {
    var intro: BookendClip?
    var outro: BookendClip?
}

/// The third time domain.
///
/// The editor has two already: **source** (`Clip.sourceRange`, `LayoutCue`,
/// `Word`) and **edited** (`Chapter.startTime`, `OverlayClip.timelineRange`).
/// Bookends force a third — **program** time, what the exported file's clock
/// reads.
///
/// The rule the whole design rests on: **authoring is never in program time.**
/// Chapters, cutaways, cues and the transcript stay exactly where they are, and
/// program time exists only inside `CompositionBuilder`, the sidecar writers,
/// and one conversion in `PreviewPlayer`.
///
/// The alternative — genuinely prepending the intro by rewriting edited times —
/// would renumber every chapter and every cutaway each time you trimmed the
/// intro. An intro edit that silently rewrites the user's chapter list is not
/// a trade worth making.
extension EditProject {
    /// How far the conversation is pushed back by an intro.
    var programOffset: Double { bookends?.intro?.duration ?? 0 }

    /// Total exported length: intro + conversation + outro.
    var programDuration: Double {
        programOffset + editedDuration + (bookends?.outro?.duration ?? 0)
    }

    func programTime(forEdited time: Double) -> Double { time + programOffset }

    func editedTime(forProgram time: Double) -> Double {
        min(max(time - programOffset, 0), editedDuration)
    }

    var hasBookends: Bool { bookends?.intro != nil || bookends?.outro != nil }

    mutating func setIntro(_ clip: BookendClip?) {
        var current = bookends ?? ProgramBookends()
        current.intro = clip
        bookends = (current.intro == nil && current.outro == nil) ? nil : current
    }

    mutating func setOutro(_ clip: BookendClip?) {
        var current = bookends ?? ProgramBookends()
        current.outro = clip
        bookends = (current.intro == nil && current.outro == nil) ? nil : current
    }
}
