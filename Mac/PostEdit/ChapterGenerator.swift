import Foundation
import os

/// AI auto-chapters over the EDITED timeline: Claude reads only the enabled
/// words (with their edited-timeline times already mapped through the EDL),
/// so chapter timestamps stay correct after cuts. Output: chapters on the
/// project, a YouTube-format text block, and (on export) chapter metadata.
final class ChapterGenerator {
    private let client: ClaudeAPIClient
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "chapters")

    init(client: ClaudeAPIClient = ClaudeAPIClient()) {
        self.client = client
    }

    func generate(transcript: Transcript, edl: EditDecisionList) async throws -> [Chapter] {
        // Enabled words with edited-timeline times.
        var editedWords: [(index: Int, text: String, timelineTime: Double)] = []
        for (index, word) in transcript.words.enumerated() {
            if let mapped = edl.mapSourceToTimeline(word.start) {
                editedWords.append((index, word.text, mapped))
            }
        }
        guard !editedWords.isEmpty else { return [] }

        let numbered = editedWords
            .map { "[\($0.index)]\($0.text)" }
            .joined(separator: " ")

        let schema: [String: Any] = [
            "type": "object",
            "additionalProperties": false,
            "required": ["chapters"],
            "properties": [
                "chapters": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["title", "startWordIndex"],
                        "properties": [
                            "title": ["type": "string"],
                            "startWordIndex": ["type": "integer"],
                        ] as [String: Any],
                    ] as [String: Any],
                ] as [String: Any],
            ],
        ]

        let system = """
        Segment this recording into YouTube chapters: 4–12 chapters, each a distinct \
        topic/beat, titles ≤6 words, punchy but accurate. The FIRST chapter must start \
        at the very first word. startWordIndex is a word index from the bracketed list.
        """
        let data = try await client.structured(system: system, user: numbered, schema: schema)

        struct Response: Decodable {
            struct RawChapter: Decodable {
                let title: String
                let startWordIndex: Int
            }
            let chapters: [RawChapter]
        }
        let response = try JSONDecoder().decode(Response.self, from: data)

        let timesByIndex = Dictionary(editedWords.map { ($0.index, $0.timelineTime) },
                                      uniquingKeysWith: { a, _ in a })
        var chapters: [Chapter] = response.chapters.compactMap { raw in
            guard let time = timesByIndex[raw.startWordIndex] else { return nil }
            return Chapter(title: raw.title, startTime: time)
        }
        .sorted { $0.startTime < $1.startTime }

        // YouTube requires the first chapter at 0:00.
        if let first = chapters.first, first.startTime > 0.5 {
            chapters[0].startTime = 0
        }
        return chapters
    }

    /// "00:00 Intro\n02:41 The pivot\n…" — paste-ready for a YouTube description.
    static func youtubeText(_ chapters: [Chapter]) -> String {
        chapters.map { chapter in
            let total = Int(chapter.startTime.rounded())
            let hours = total / 3600
            let minutes = (total % 3600) / 60
            let seconds = total % 60
            let stamp = hours > 0
                ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
                : String(format: "%02d:%02d", minutes, seconds)
            return "\(stamp) \(chapter.title)"
        }
        .joined(separator: "\n")
    }
}
