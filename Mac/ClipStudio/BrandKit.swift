import Foundation

/// Brand kit applied to exports: fonts/colors for captions, logo watermark,
/// intro/outro stingers, default caption template. Stored app-wide with
/// per-project overrides.
struct BrandKit: Codable, Equatable {
    struct Watermark: Codable, Equatable {
        var media: MediaReference?
        /// Unit position of the watermark's center.
        var position: CGPoint = CGPoint(x: 0.9, y: 0.08)
        var opacity: Double = 0.7
        /// Fraction of output width.
        var width: Double = 0.12
    }

    var fontName: String = ""
    var primaryColorHex: String = "#FFFFFF"
    var accentColorHex: String = "#FFD60A"
    var watermark = Watermark()
    var introStinger: MediaReference?
    var outroStinger: MediaReference?
    var defaultCaptionPreset: String = "Karaoke"

    /// Caption style derived from the kit (preset shape + brand colors/font).
    func captionStyle() -> CaptionStyle {
        var style = CaptionStyle.presets.first { $0.name == defaultCaptionPreset }?.style ?? .karaoke
        style.fontName = fontName
        style.fillColorHex = primaryColorHex
        style.highlightColorHex = accentColorHex
        return style
    }
}

final class BrandKitStore {
    private var url: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Streamit/brand-kit.json")
    }

    func load() -> BrandKit {
        guard let data = try? Data(contentsOf: url),
              let kit = try? JSONDecoder().decode(BrandKit.self, from: data) else {
            return BrandKit()
        }
        return kit
    }

    func save(_ kit: BrandKit) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(kit) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }
}

/// B-roll suggestions: Claude tags transcript segments that would benefit
/// from cutaways with search terms; sources are the session's own assets
/// first, then the user's media library — always suggestions-with-review,
/// never auto-committed. (AI-generated B-roll is out of scope for v1.)
struct BRollSuggestion: Identifiable {
    let id = UUID()
    var timeRange: ClosedRange<Double>
    var reason: String
    var searchTerms: [String]
    /// Local candidates matched by filename against searchTerms.
    var localCandidates: [URL] = []
}

final class BRollSuggester {
    private let client: ClaudeAPIClient

    init(client: ClaudeAPIClient = ClaudeAPIClient()) {
        self.client = client
    }

    func suggest(transcript: Transcript, mediaLibrary: [URL]) async throws -> [BRollSuggestion] {
        guard !transcript.words.isEmpty else { return [] }
        let numbered = transcript.words.enumerated()
            .map { "[\($0.offset)]\($0.element.text)" }
            .joined(separator: " ")

        let schema: [String: Any] = [
            "type": "object",
            "additionalProperties": false,
            "required": ["suggestions"],
            "properties": [
                "suggestions": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["inWordIndex", "outWordIndex", "reason", "searchTerms"],
                        "properties": [
                            "inWordIndex": ["type": "integer"],
                            "outWordIndex": ["type": "integer"],
                            "reason": ["type": "string"],
                            "searchTerms": ["type": "array", "items": ["type": "string"]],
                        ] as [String: Any],
                    ] as [String: Any],
                ] as [String: Any],
            ],
        ]
        let system = """
        Identify transcript segments (3–10 seconds) that would benefit from B-roll \
        cutaways — concrete nouns, places, products, processes being described. For \
        each: word-index range, why, and 2–4 stock-search terms. Skip abstract \
        discussion; fewer, better suggestions.
        """
        let data = try await client.structured(system: system, user: numbered, schema: schema)

        struct Response: Decodable {
            struct Raw: Decodable {
                let inWordIndex: Int
                let outWordIndex: Int
                let reason: String
                let searchTerms: [String]
            }
            let suggestions: [Raw]
        }
        let response = try JSONDecoder().decode(Response.self, from: data)
        let count = transcript.words.count

        return response.suggestions.compactMap { raw in
            let inIndex = min(max(raw.inWordIndex, 0), count - 1)
            let outIndex = min(max(raw.outWordIndex, inIndex), count - 1)
            let terms = raw.searchTerms.map { $0.lowercased() }
            let candidates = mediaLibrary.filter { url in
                let name = url.deletingPathExtension().lastPathComponent.lowercased()
                return terms.contains { name.contains($0) }
            }
            return BRollSuggestion(
                timeRange: transcript.words[inIndex].start...transcript.words[outIndex].end,
                reason: raw.reason,
                searchTerms: raw.searchTerms,
                localCandidates: candidates)
        }
    }
}
