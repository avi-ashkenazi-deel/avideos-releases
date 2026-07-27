import Foundation
import os

/// Best-take assembly: for each script section with multiple takes, Claude
/// picks the take and in/out **word indices** — never raw timestamps, so a
/// hallucinated number can at worst pick a wrong word, not corrupt the
/// timeline. Indices are validated/clamped locally, mapped to times, and
/// snapped to silence before touching the EDL. Nothing applies until the
/// user accepts the proposal.
final class ClaudeTakeSelector {
    struct SectionProposal: Identifiable {
        let id = UUID()
        var sectionLabel: String
        var chosenTake: ScriptTake
        var rejectedTakes: [ScriptTake]
        var inTime: Double
        var outTime: Double
        var additionalCuts: [ClosedRange<Double>]
        var confidence: String
        var rationale: String
        var accepted = true
    }

    private let client: ClaudeAPIClient
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "takeselector")

    init(client: ClaudeAPIClient = ClaudeAPIClient()) {
        self.client = client
    }

    // MARK: - Selection

    func propose(takes: [ScriptTake],
                 transcript: Transcript,
                 script: ScriptDocument,
                 snapper: SilenceSnapper?) async throws -> [SectionProposal] {
        let groups = TakeDetector.retakeGroups(takes).filter { $0.count > 1 }
        guard !groups.isEmpty else { return [] }

        let scriptTokens = script.tokens()

        var sectionsPayload: [[String: Any]] = []
        var takesByID: [String: ScriptTake] = [:]
        for (groupIndex, group) in groups.enumerated() {
            let scriptRange = group[0].scriptTokenRange
            let scriptText = scriptTokens[max(0, scriptRange.lowerBound)..<min(scriptRange.upperBound, scriptTokens.count)]
                .joined(separator: " ")
            var takesPayload: [[String: Any]] = []
            for (takeIndex, take) in group.enumerated() {
                let takeID = "s\(groupIndex)t\(takeIndex)"
                takesByID[takeID] = take
                let words = transcript.words[safeRange(take.transcriptWordRange, max: transcript.words.count)]
                let numbered = words.enumerated().map { offset, word in
                    let index = take.transcriptWordRange.lowerBound + offset
                    return word.isDisfluency ? "[\(index)]<\(word.text)>" : "[\(index)]\(word.text)"
                }.joined(separator: " ")
                takesPayload.append([
                    "takeId": takeID,
                    "words": numbered,
                    "signals": [
                        "completedFraction": take.signals.completedFraction,
                        "disfluencyCount": take.signals.disfluencyCount,
                        "restartDetected": take.signals.restartDetected,
                        "wordsPerMinute": take.signals.wordsPerMinute,
                        "trailingAbandon": take.signals.trailingAbandon,
                    ] as [String: Any],
                ])
            }
            sectionsPayload.append([
                "sectionId": "s\(groupIndex)",
                "script": scriptText,
                "takes": takesPayload,
            ])
        }

        let schema: [String: Any] = [
            "type": "object",
            "additionalProperties": false,
            "required": ["sections"],
            "properties": [
                "sections": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["sectionId", "chosenTakeId", "inWordIndex", "outWordIndex", "confidence", "rationale"],
                        "properties": [
                            "sectionId": ["type": "string"],
                            "chosenTakeId": ["type": "string"],
                            "inWordIndex": ["type": "integer"],
                            "outWordIndex": ["type": "integer"],
                            "confidence": ["type": "string", "enum": ["high", "medium", "low"]],
                            "rationale": ["type": "string"],
                            "additionalCuts": [
                                "type": "array",
                                "items": [
                                    "type": "object",
                                    "additionalProperties": false,
                                    "required": ["fromWordIndex", "toWordIndex", "reason"],
                                    "properties": [
                                        "fromWordIndex": ["type": "integer"],
                                        "toWordIndex": ["type": "integer"],
                                        "reason": ["type": "string"],
                                    ] as [String: Any],
                                ] as [String: Any],
                            ] as [String: Any],
                        ] as [String: Any],
                    ] as [String: Any],
                ] as [String: Any],
            ],
        ]

        let system = """
        You are an audio/video editor assembling the best take of a scripted recording.
        For each section, choose exactly ONE take (the most complete, fluent, energetic \
        read; the signals are ground truth). Cut boundaries are WORD INDICES from the \
        bracketed word list — never invent indices outside a take's range. Words in \
        <angle brackets> are disfluencies. Use additionalCuts only for clear flubs \
        inside the chosen take (a stumble followed by a clean restart).
        """
        let userPayload = try JSONSerialization.data(withJSONObject: ["sections": sectionsPayload])
        let user = String(data: userPayload, encoding: .utf8) ?? ""

        let responseData = try await client.structured(system: system, user: user, schema: schema)
        return try buildProposals(from: responseData,
                                  groups: groups,
                                  takesByID: takesByID,
                                  transcript: transcript,
                                  snapper: snapper)
    }

    private func buildProposals(from data: Data,
                                groups: [[ScriptTake]],
                                takesByID: [String: ScriptTake],
                                transcript: Transcript,
                                snapper: SilenceSnapper?) throws -> [SectionProposal] {
        struct Response: Decodable {
            struct Section: Decodable {
                struct Cut: Decodable {
                    let fromWordIndex: Int
                    let toWordIndex: Int
                    let reason: String
                }
                let sectionId: String
                let chosenTakeId: String
                let inWordIndex: Int
                let outWordIndex: Int
                let confidence: String
                let rationale: String
                let additionalCuts: [Cut]?
            }
            let sections: [Section]
        }

        let response = try JSONDecoder().decode(Response.self, from: data)
        var proposals: [SectionProposal] = []

        for section in response.sections {
            guard let chosen = takesByID[section.chosenTakeId],
                  let groupIndex = Int(section.sectionId.dropFirst()),   // "s3" → 3
                  groups.indices.contains(groupIndex) else {
                log.warning("Skipping proposal with unknown ids: \(section.sectionId)/\(section.chosenTakeId)")
                continue
            }
            let group = groups[groupIndex]

            // Clamp indices into the chosen take's real word range.
            let range = chosen.transcriptWordRange
            let inIndex = min(max(section.inWordIndex, range.lowerBound), range.upperBound - 1)
            let outIndex = min(max(section.outWordIndex, inIndex), range.upperBound - 1)

            var inTime = transcript.words[inIndex].start
            var outTime = transcript.words[outIndex].end
            if let snapper {
                inTime = snapper.snap(inTime)
                outTime = snapper.snap(outTime)
            }
            guard outTime > inTime else { continue }

            var cuts: [ClosedRange<Double>] = []
            for cut in section.additionalCuts ?? [] {
                let from = min(max(cut.fromWordIndex, range.lowerBound), range.upperBound - 1)
                let to = min(max(cut.toWordIndex, from), range.upperBound - 1)
                var start = transcript.words[from].start
                var end = transcript.words[to].end
                if let snapper {
                    start = snapper.snap(start)
                    end = snapper.snap(end)
                }
                if end > start { cuts.append(start...end) }
            }

            proposals.append(SectionProposal(
                sectionLabel: "Section \(groupIndex + 1)",
                chosenTake: chosen,
                rejectedTakes: group.filter { $0.id != chosen.id },
                inTime: inTime,
                outTime: outTime,
                additionalCuts: cuts,
                confidence: section.confidence,
                rationale: section.rationale))
        }
        return proposals
    }

    // MARK: - Application

    /// Applies accepted proposals: rejected takes disable as .cutRetake,
    /// trims outside the chosen in/out disable too, flubs as .cutFlub.
    /// Everything stays recoverable in the EDL.
    static func apply(_ proposals: [SectionProposal], to edl: inout EditDecisionList) {
        for proposal in proposals where proposal.accepted {
            for rejected in proposal.rejectedTakes {
                _ = edl.deleteRange(rejected.timeRange, label: .cutRetake)
            }
            // Trim the chosen take's head/tail beyond the selected words.
            let take = proposal.chosenTake.timeRange
            if proposal.inTime - take.lowerBound > 0.05 {
                _ = edl.deleteRange(take.lowerBound...proposal.inTime, label: .cutFlub)
            }
            if take.upperBound - proposal.outTime > 0.05 {
                _ = edl.deleteRange(proposal.outTime...take.upperBound, label: .cutFlub)
            }
            for cut in proposal.additionalCuts {
                _ = edl.deleteRange(cut, label: .cutFlub)
            }
        }
    }

    private func safeRange(_ range: Range<Int>, max maxValue: Int) -> Range<Int> {
        let lower = Swift.max(0, Swift.min(range.lowerBound, maxValue))
        let upper = Swift.max(lower, Swift.min(range.upperBound, maxValue))
        return lower..<upper
    }
}
