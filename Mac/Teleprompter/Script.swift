import Foundation

/// One readable unit of a script. `sceneID` optionally binds the section to a
/// scene in the current project so switching scenes can auto-jump the prompter.
struct ScriptSection: Identifiable, Codable, Hashable, Sendable {
    var id: UUID = UUID()
    var heading: String = ""
    var body: String = ""
    var sceneID: UUID?

    /// Title shown in pickers and sent to the phone remote. Falls back to the
    /// first few words of the body for heading-less sections.
    var displayTitle: String {
        let trimmed = heading.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        let words = body.split(separator: " ", omittingEmptySubsequences: true).prefix(5)
        return words.isEmpty ? "Untitled section" : words.joined(separator: " ") + "…"
    }

    /// Normalized word stream (lowercased, punctuation stripped) consumed by
    /// transcript alignment. Keep the normalization identical to whatever the
    /// aligner applies to ASR output or offsets will drift.
    func tokens() -> [String] {
        ScriptDocument.tokenize(heading + " " + body)
    }
}

struct ScriptDocument: Identifiable, Codable, Hashable, Sendable {
    var id: UUID = UUID()
    var title: String = "Untitled Script"
    var sections: [ScriptSection] = []

    func tokens() -> [String] {
        sections.flatMap { $0.tokens() }
    }

    /// Immutable copy captured at record start; the exact script the host read
    /// is stored with the session even if the live document is edited later.
    func snapshotForRecording() -> ScriptSnapshot {
        ScriptSnapshot(scriptID: id, title: title, capturedAt: Date(), sections: sections)
    }

    static func tokenize(_ text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .map { word in
                String(String.UnicodeScalarView(word.unicodeScalars.filter {
                    !CharacterSet.punctuationCharacters.contains($0) && !CharacterSet.symbols.contains($0)
                }))
            }
            .filter { !$0.isEmpty }
    }

    // MARK: - Plain-text / markdown import

    /// Splits pasted plain text into sections. A section boundary is either a
    /// markdown heading (`#`, `##`, …) or an ALL-CAPS line followed by a blank
    /// line — the two conventions people actually paste from Docs/Notes.
    static func importing(plainText: String, title: String = "Imported Script") -> ScriptDocument {
        let lines = plainText.components(separatedBy: .newlines)
        var sections: [ScriptSection] = []
        var heading = ""
        var bodyLines: [String] = []

        func flush() {
            let body = bodyLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !heading.isEmpty || !body.isEmpty {
                sections.append(ScriptSection(heading: heading, body: body))
            }
            heading = ""
            bodyLines = []
        }

        for (index, raw) in lines.enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if let markdownHeading = markdownHeading(from: line) {
                flush()
                heading = markdownHeading
            } else if isAllCapsHeading(line), followedByBlank(lines, after: index) {
                flush()
                heading = line
            } else {
                bodyLines.append(raw)
            }
        }
        flush()

        if sections.isEmpty {
            sections = [ScriptSection(heading: "", body: plainText.trimmingCharacters(in: .whitespacesAndNewlines))]
        }
        return ScriptDocument(title: title, sections: sections)
    }

    private static func markdownHeading(from line: String) -> String? {
        guard line.hasPrefix("#") else { return nil }
        let stripped = line.drop(while: { $0 == "#" })
        guard stripped.first == " " || stripped.isEmpty else { return nil } // "#hashtag" is body text
        let text = stripped.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    private static func isAllCapsHeading(_ line: String) -> Bool {
        guard !line.isEmpty, line.count <= 64 else { return false }
        let letters = line.unicodeScalars.filter { CharacterSet.letters.contains($0) }
        guard letters.count >= 2 else { return false }
        return line == line.uppercased() && line != line.lowercased()
    }

    private static func followedByBlank(_ lines: [String], after index: Int) -> Bool {
        let next = index + 1
        guard next < lines.count else { return true } // last line counts as a heading too
        return lines[next].trimmingCharacters(in: .whitespaces).isEmpty
    }
}

/// Frozen script attached to a recording session. All `let` so it can never
/// diverge from what was on screen.
struct ScriptSnapshot: Codable, Hashable, Sendable {
    let scriptID: UUID
    let title: String
    let capturedAt: Date
    let sections: [ScriptSection]

    func tokens() -> [String] {
        sections.flatMap { $0.tokens() }
    }
}
