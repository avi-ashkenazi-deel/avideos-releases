import Foundation

/// Post-pass that asks Claude to fix punctuation and capitalization on a
/// finished transcript — Whisper's own punctuation is serviceable but flat
/// (missing question marks, mid-sentence capitals, comma splices).
///
/// The contract follows the take-selector's rule: Claude only ever returns
/// WORD INDICES plus replacement text, never timestamps, and every
/// correction is validated locally — the letters of the replacement must
/// match the original word's letters, so the model can adjust case and
/// attached punctuation but can never rewrite, merge, or drop a word.
/// Timings are untouched by construction.
struct PunctuationPolisher {
    /// Words per request; well inside the output budget even if every word
    /// came back corrected.
    var chunkSize = 400
    var client = ClaudeAPIClient()

    private struct Response: Decodable {
        struct Correction: Decodable {
            let index: Int
            let text: String
        }
        let corrections: [Correction]
    }

    private static let schema: [String: Any] = [
        "type": "object",
        "properties": [
            "corrections": [
                "type": "array",
                "items": [
                    "type": "object",
                    "properties": [
                        "index": ["type": "integer"],
                        "text": ["type": "string"],
                    ],
                    "required": ["index", "text"],
                    "additionalProperties": false,
                ],
            ],
        ],
        "required": ["corrections"],
        "additionalProperties": false,
    ]

    /// Returns the polished transcript and how many words changed.
    func polish(_ transcript: Transcript) async throws -> (transcript: Transcript, changed: Int) {
        var words = transcript.words
        var changed = 0

        var start = 0
        while start < words.count {
            let end = min(start + chunkSize, words.count)
            let listing = (start..<end)
                .map { "\($0)\t\(words[$0].text)" }
                .joined(separator: "\n")

            let data = try await client.structured(
                system: """
                You fix punctuation and capitalization in speech transcripts. \
                You receive numbered words, one per line. Return corrections ONLY \
                for words whose text should change — the same word with corrected \
                case and attached punctuation (periods, commas, question marks, \
                quotes, apostrophes). NEVER change the letters of a word, never \
                merge or split words, never add or remove words. Sentence starts \
                get capitals; questions get question marks; drop stray mid-sentence \
                capitals.
                """,
                user: listing,
                schema: Self.schema,
                // Punctuation is mechanical — the faster model is plenty.
                model: "claude-sonnet-5")

            let response = try JSONDecoder().decode(Response.self, from: data)
            for correction in response.corrections {
                guard correction.index >= start, correction.index < end else { continue }
                let trimmed = correction.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty,
                      Self.letters(of: trimmed) == Self.letters(of: words[correction.index].text),
                      trimmed != words[correction.index].text else { continue }
                words[correction.index].text = trimmed
                changed += 1
            }
            start = end
        }

        var polished = transcript
        polished.words = words
        return (polished, changed)
    }

    /// The identity that must survive a correction: letters and digits,
    /// case-folded — punctuation and case are exactly what MAY change.
    private static func letters(of text: String) -> String {
        String(text.lowercased().unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0)
        })
    }
}
