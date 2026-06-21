import Foundation

/// Looks up a bundled audio clip for a spoken phrase, so you can drop in your own
/// recordings that play instead of the synthesized voice. The phrase is "slugged"
/// to a filename:
///
///   "10"          -> 10
///   "Rest"        -> rest
///   "Go"          -> go
///   "Round 2"     -> round-2
///   "Interval 3"  -> interval-3
///   "30 seconds"  -> 30-seconds
///   "Push harder" -> push-harder   (any custom cue label works too)
///
/// Put matching files (mp3 / m4a / wav / caf) in `Shared/Sounds/`. Any phrase
/// without a clip just uses text-to-speech, so you can record only the ones you
/// care about (e.g. the countdown 10…1 and "break").
enum VoiceClips {
    private static let extensions = ["mp3", "m4a", "wav", "caf"]

    /// The bundled clip URL for a phrase, or nil to fall back to speech.
    static func url(forPhrase phrase: String) -> URL? {
        let name = slug(phrase)
        guard !name.isEmpty else { return nil }
        for ext in extensions {
            if let url = Bundle.main.url(forResource: name, withExtension: ext) {
                return url
            }
        }
        return nil
    }

    /// Lowercase; apostrophes are dropped (so "Let's go" → "lets-go"), and runs
    /// of other non-alphanumerics collapse to a single dash.
    static func slug(_ phrase: String) -> String {
        var out = ""
        var pendingDash = false
        let stripped = phrase.lowercased().replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "\u{2019}", with: "")
        for ch in stripped {
            if ch.isLetter || ch.isNumber {
                if pendingDash, !out.isEmpty { out.append("-") }
                out.append(ch)
                pendingDash = false
            } else {
                pendingDash = true
            }
        }
        return out
    }
}
