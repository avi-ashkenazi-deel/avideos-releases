import Foundation
import NaturalLanguage

/// Small language utilities shared by the speech engine (pick a matching voice)
/// and the UI (lay out right-to-left scripts like Hebrew/Arabic correctly).
enum LanguageTools {

    /// Dominant language code for a piece of text, e.g. "en", "he", "fr".
    static func languageCode(for text: String) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let raw = recognizer.dominantLanguage?.rawValue else { return nil }
        // Yiddish shares the Hebrew script and the recognizer often tags modern
        // Hebrew as Yiddish; there's no Yiddish TTS voice, so map it to Hebrew
        // (otherwise the text falls back to a silent English voice).
        return raw == "yi" ? "he" : raw
    }

    /// Language code for a single chunk, but *only* when we're confident — the text
    /// is long enough and the top hypothesis is strong. Returns nil otherwise so the
    /// caller can fall back to the email's dominant language. This lets a
    /// mixed-language email read each sentence in the right voice (e.g. a Spanish
    /// opening line in an English email reads Spanish, the rest reads English),
    /// without a short or ambiguous fragment flipping the voice incorrectly.
    static func confidentLanguageCode(for text: String,
                                      minLength: Int = 20,
                                      minConfidence: Double = 0.80) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= minLength else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(trimmed)
        guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first,
              confidence >= minConfidence else { return nil }
        let raw = language.rawValue
        return raw == "yi" ? "he" : raw
    }

    /// True when the text is mostly a right-to-left script (Hebrew, Arabic, …),
    /// so it should be right-aligned.
    static func isRightToLeft(_ text: String) -> Bool {
        var rtl = 0
        var ltr = 0
        for scalar in text.unicodeScalars {
            let v = scalar.value
            // Hebrew, Arabic, Syriac, Thaana + Arabic presentation forms.
            if (0x0590...0x08FF).contains(v) || (0xFB1D...0xFDFF).contains(v) || (0xFE70...0xFEFF).contains(v) {
                rtl += 1
            } else if (0x0041...0x024F).contains(v) { // Latin letters
                ltr += 1
            }
        }
        return rtl > ltr
    }
}
