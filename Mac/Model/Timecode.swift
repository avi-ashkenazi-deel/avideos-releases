import Foundation

/// One spelling for "seconds → clock string".
///
/// Five views used to carry private copies of this and they had already
/// drifted (some rolled past the hour, some didn't). YouTube chapter stamps
/// (`ChapterGenerator.youtubeText`) deliberately stay separate — that format
/// is YouTube's ("00:00" with two-digit minutes), not ours.
enum Timecode {
    /// "3:21", rolling to "1:02:05" past the hour.
    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
    }

    /// "0:03.4" — tenths, for trim handles where sub-second matters.
    static func tenths(_ seconds: Double) -> String {
        let total = max(0, seconds)
        let minutes = Int(total) / 60
        let secs = total - Double(minutes * 60)
        return String(format: "%d:%04.1f", minutes, secs)
    }
}
