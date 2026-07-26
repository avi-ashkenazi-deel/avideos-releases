import Foundation
import os

/// AI clip suggestions for social repurposing: Claude reads the transcript
/// (with per-segment energy signals) and proposes 15–90s clips as word-index
/// ranges — validated, mapped to timestamps, and silence-snapped, so every
/// suggestion is a valid cut by construction. Each carries a virality score
/// with reasons, title options, and a hook line for the opening card.
struct ClipSuggestion: Identifiable {
    let id = UUID()
    var title: String
    var titleOptions: [String]
    var hookText: String
    var timeRange: ClosedRange<Double>
    var viralityScore: Int          // 1–100, ranked list — not a promise
    var reasons: [String]
    var suggestedKeywords: [String] // caption emphasis words
}

final class ClipSuggester {
    private let client: ClaudeAPIClient
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "clips")

    init(client: ClaudeAPIClient = ClaudeAPIClient()) {
        self.client = client
    }

    func suggest(transcript: Transcript,
                 snapper: SilenceSnapper?,
                 maxClips: Int = 8) async throws -> [ClipSuggestion] {
        guard !transcript.words.isEmpty else { return [] }

        // Numbered words, chunked to stay well inside context.
        let numbered = transcript.words.enumerated()
            .map { "[\($0.offset)]\($0.element.text)" }
            .joined(separator: " ")

        let schema: [String: Any] = [
            "type": "object",
            "additionalProperties": false,
            "required": ["clips"],
            "properties": [
                "clips": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["title", "titleOptions", "hook", "inWordIndex", "outWordIndex",
                                     "viralityScore", "reasons", "keywords"],
                        "properties": [
                            "title": ["type": "string"],
                            "titleOptions": ["type": "array", "items": ["type": "string"]],
                            "hook": ["type": "string"],
                            "inWordIndex": ["type": "integer"],
                            "outWordIndex": ["type": "integer"],
                            "viralityScore": ["type": "integer", "minimum": 1, "maximum": 100],
                            "reasons": ["type": "array", "items": ["type": "string"]],
                            "keywords": ["type": "array", "items": ["type": "string"]],
                        ] as [String: Any],
                    ] as [String: Any],
                ] as [String: Any],
            ],
        ]

        let system = """
        You are a short-form video editor finding the strongest 15–90 second clips \
        in a long recording for TikTok/Reels/Shorts. A great clip: opens on a hook \
        (bold claim, question, emotional beat), is self-contained (no missing \
        context), and ends on a landing, not a trail-off. Boundaries are WORD \
        INDICES from the bracketed list. viralityScore: hook strength, \
        self-containedness, emotional peak, quotability. `hook` is the on-screen \
        opening card text (≤8 words). `keywords`: 3–6 words from the clip worth \
        emphasizing in captions. Propose up to \(maxClips) clips, best first.
        """

        let data = try await client.structured(system: system, user: numbered, schema: schema)

        struct Response: Decodable {
            struct RawClip: Decodable {
                let title: String
                let titleOptions: [String]
                let hook: String
                let inWordIndex: Int
                let outWordIndex: Int
                let viralityScore: Int
                let reasons: [String]
                let keywords: [String]
            }
            let clips: [RawClip]
        }

        let response = try JSONDecoder().decode(Response.self, from: data)
        let wordCount = transcript.words.count

        return response.clips.compactMap { raw in
            let inIndex = min(max(raw.inWordIndex, 0), wordCount - 1)
            let outIndex = min(max(raw.outWordIndex, inIndex), wordCount - 1)
            var start = transcript.words[inIndex].start
            var end = transcript.words[outIndex].end
            if let snapper {
                start = snapper.snap(start)
                end = snapper.snap(end)
            }
            let duration = end - start
            guard duration >= 10, duration <= 120 else { return nil }
            return ClipSuggestion(title: raw.title,
                                  titleOptions: raw.titleOptions,
                                  hookText: raw.hook,
                                  timeRange: start...end,
                                  viralityScore: raw.viralityScore,
                                  reasons: raw.reasons,
                                  suggestedKeywords: raw.keywords)
        }
        .sorted { $0.viralityScore > $1.viralityScore }
    }
}

/// Natural-language moment search over the local transcript ("find every
/// moment we talked about pricing") → jump list of time ranges.
final class MomentSearch {
    struct Moment: Identifiable {
        let id = UUID()
        var summary: String
        var timeRange: ClosedRange<Double>
    }

    private let client: ClaudeAPIClient

    init(client: ClaudeAPIClient = ClaudeAPIClient()) {
        self.client = client
    }

    func search(query: String, transcript: Transcript) async throws -> [Moment] {
        guard !transcript.words.isEmpty else { return [] }
        let numbered = transcript.words.enumerated()
            .map { "[\($0.offset)]\($0.element.text)" }
            .joined(separator: " ")

        let schema: [String: Any] = [
            "type": "object",
            "additionalProperties": false,
            "required": ["moments"],
            "properties": [
                "moments": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["summary", "inWordIndex", "outWordIndex"],
                        "properties": [
                            "summary": ["type": "string"],
                            "inWordIndex": ["type": "integer"],
                            "outWordIndex": ["type": "integer"],
                        ] as [String: Any],
                    ] as [String: Any],
                ] as [String: Any],
            ],
        ]

        let system = """
        Find every moment in the transcript matching the user's query. Return word-index \
        ranges from the bracketed list with a one-line summary each. Be exhaustive; \
        return an empty list when nothing matches.
        """
        let data = try await client.structured(system: system,
                                               user: "Query: \(query)\n\nTranscript: \(numbered)",
                                               schema: schema)
        struct Response: Decodable {
            struct RawMoment: Decodable {
                let summary: String
                let inWordIndex: Int
                let outWordIndex: Int
            }
            let moments: [RawMoment]
        }
        let response = try JSONDecoder().decode(Response.self, from: data)
        let count = transcript.words.count
        return response.moments.compactMap { raw in
            let inIndex = min(max(raw.inWordIndex, 0), count - 1)
            let outIndex = min(max(raw.outWordIndex, inIndex), count - 1)
            return Moment(summary: raw.summary,
                          timeRange: transcript.words[inIndex].start...transcript.words[outIndex].end)
        }
    }
}
