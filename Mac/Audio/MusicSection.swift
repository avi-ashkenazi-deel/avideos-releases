import Foundation

/// A named region of a music track the host can jump to live.
///
/// Times are seconds from the start of the *file* — the same clock as
/// `MusicPlayer.position`, the transport scrubber and `seek(to:)`, so there is
/// exactly one time domain on the live side. Frames would be the only
/// non-seconds quantity in `audio-settings.json`, and would silently shift by
/// ~9% if the file were ever re-encoded from 44.1 to 48 kHz.
struct MusicSection: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var start: Double
    /// `nil` means *open*: the section runs to the next section's start, or to
    /// the end of the file if it is the last one.
    ///
    /// This is what makes marking a track by ear work. Tapping three times
    /// while it plays gives contiguous intro/verse/chorus with nothing silently
    /// mutated; dragging a right-hand handle is what converts a derived end
    /// into an explicit one.
    var end: Double?
    var colorHex: String
    /// 1-based, the same namespace and semantics as `SoundPad.hotkeyIndex`.
    var hotkeyIndex: Int?
    /// Authored default. The live "is it looping right now" state is separate,
    /// so you can let a song run out mid-show without editing your sections.
    var loops: Bool

    init(id: UUID = UUID(),
         name: String,
         start: Double,
         end: Double? = nil,
         colorHex: String,
         hotkeyIndex: Int? = nil,
         loops: Bool = true) {
        self.id = id
        self.name = name
        self.start = start
        self.end = end
        self.colorHex = colorHex
        self.hotkeyIndex = hotkeyIndex
        self.loops = loops
    }
}

extension MusicSection {
    /// Shortest section worth having. Below this a loop is a buzz, and a
    /// zero-length schedule would complete immediately and spin its completion
    /// handler.
    static let minimumLength: Double = 0.25

    /// Resolves open ends against the following section, in one place, because
    /// the timeline drawing, the engine and the hotkey layer must all agree.
    ///
    /// `sections` is expected sorted by `start` — `MusicTrack.sorted` keeps it
    /// that way on every write.
    static func resolvedRanges(_ sections: [MusicSection],
                               duration: Double) -> [UUID: ClosedRange<Double>] {
        var result: [UUID: ClosedRange<Double>] = [:]
        for (index, section) in sections.enumerated() {
            let derivedEnd = index + 1 < sections.count ? sections[index + 1].start : duration
            let upper = min(section.end ?? derivedEnd, duration)
            let lower = max(0, min(section.start, duration))
            guard upper - lower >= minimumLength else { continue }
            result[section.id] = lower...upper
        }
        return result
    }

    /// The lowest hotkey slot 1…9 not already spoken for, or nil when full.
    /// Mirrors `addPad`'s auto-assign: a marker you can't immediately fire
    /// misses the point of dropping it while the track plays.
    static func nextFreeHotkeyIndex(in sections: [MusicSection]) -> Int? {
        let taken = Set(sections.compactMap(\.hotkeyIndex))
        return (1...9).first { !taken.contains($0) }
    }
}

/// Colours shared by sound pads and music sections, so the two performance
/// surfaces look like one app. Hoisted out of `SoundPad` unchanged — the array
/// and its order must stay identical or every existing pad's hash-derived
/// colour would shift.
enum AudioPalette {
    static let colors = ["#E4573D", "#EFA94A", "#57A66E", "#4A90D9",
                         "#9B6BD3", "#D35C9B", "#4AC0BE", "#C9B458"]

    static func color(forIndex index: Int) -> String {
        colors[abs(index) % colors.count]
    }
}

// MARK: - Timecode

/// Parsing and formatting for the section editor's typed fields and every
/// elapsed/duration label, so they all agree on what "1:23.480" means.
enum MusicTimecode {
    /// Accepts `ss`, `ss.mmm`, `m:ss`, `m:ss.mmm`, `h:mm:ss.mmm`.
    /// Returns nil rather than a wrong number, so a bad field can revert.
    static func parse(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 3 else { return nil }

        var total: Double = 0
        for (offset, part) in parts.enumerated() {
            guard let value = Double(part), value >= 0 else { return nil }
            // Only the last component may be fractional; 1:2.5:03 is nonsense.
            if offset < parts.count - 1, value != value.rounded(.down) { return nil }
            if offset < parts.count - 1, value >= 60, offset > 0 { return nil }
            total = total * 60 + value
        }
        return total
    }

    /// `1:23.480`, or `1:02:03.000` past an hour.
    static func string(from seconds: Double) -> String {
        let clamped = max(0, seconds)
        let whole = Int(clamped)
        let millis = Int(((clamped - Double(whole)) * 1000).rounded())
        let (hours, minutes, secs) = (whole / 3600, (whole % 3600) / 60, whole % 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d.%03d", hours, minutes, secs, millis)
            : String(format: "%d:%02d.%03d", minutes, secs, millis)
    }

    /// `1:23` — the compact form for transport labels.
    static func shortString(from seconds: Double) -> String {
        let total = Int(max(0, seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
