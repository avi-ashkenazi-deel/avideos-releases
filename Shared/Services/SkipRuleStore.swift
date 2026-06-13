import Foundation
import Combine

/// A phrase the listener never wants read aloud — optionally scoped to one
/// sender's domain. Built for the recurring chrome newsletters repeat in every
/// issue (Substack's "Read in app", "Like / Comment / Restack", …).
struct SkipRule: Identifiable, Codable, Hashable, Sendable {
    var id: String = UUID().uuidString
    /// The text to match (the sentence the listener chose to skip).
    var phrase: String
    /// Lowercased sender domain this applies to; empty = every sender.
    var senderDomain: String
    /// Sender display name, just so the rules list reads nicely.
    var label: String

    func matches(_ text: String, fromAddress: String) -> Bool {
        if !senderDomain.isEmpty, senderDomain != SkipRuleStore.domain(of: fromAddress) {
            return false
        }
        let needle = SkipRuleStore.normalize(phrase)
        guard needle.count >= 3 else { return false }
        return SkipRuleStore.normalize(text).contains(needle)
    }

    var scopeDescription: String {
        senderDomain.isEmpty ? "All senders" : senderDomain
    }
}

/// Persists the listener's skip rules (shared app-group JSON) and applies them
/// while parsing, dropping any sentence that matches a rule for the sender.
@MainActor
final class SkipRuleStore: ObservableObject {

    static let shared = SkipRuleStore()

    @Published private(set) var rules: [SkipRule] = []

    private let fileURL: URL

    init(containerURL: URL = AppGroup.containerURL) {
        self.fileURL = containerURL.appendingPathComponent("skip-rules.json")
        load()
    }

    // MARK: - Mutations

    /// Add a rule (deduped by phrase + scope). Returns false if it already exists.
    @discardableResult
    func add(phrase: String, senderDomain: String, label: String) -> Bool {
        let trimmed = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        let domain = senderDomain.lowercased()
        let exists = rules.contains {
            $0.senderDomain == domain && Self.normalize($0.phrase) == Self.normalize(trimmed)
        }
        guard !exists else { return false }
        rules.insert(SkipRule(phrase: trimmed, senderDomain: domain, label: label), at: 0)
        save()
        return true
    }

    func remove(_ id: SkipRule.ID) {
        rules.removeAll { $0.id == id }
        save()
    }

    // MARK: - Applying

    func shouldSkip(_ text: String, fromAddress: String) -> Bool {
        rules.contains { $0.matches(text, fromAddress: fromAddress) }
    }

    /// Drop sentence blocks matching a rule for this sender. Images are always
    /// kept. Never returns an empty list (if a rule would remove everything, the
    /// original blocks are returned so there's still something to read).
    func filter(_ blocks: [ContentBlock], fromAddress: String) -> [ContentBlock] {
        guard !rules.isEmpty else { return blocks }
        let kept = blocks.filter { block in
            guard case .sentence(let s) = block else { return true }
            return !shouldSkip(s.text, fromAddress: fromAddress)
        }
        return kept.isEmpty ? blocks : kept
    }

    // MARK: - Helpers

    static func domain(of address: String) -> String {
        address.split(separator: "@").last.map { $0.lowercased() } ?? ""
    }

    static func normalize(_ s: String) -> String {
        let punct = CharacterSet(charactersIn: ".,!?:;·•|-–—()[]\"'“”")
        return s.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: punct)
            .trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder.iso.decode([SkipRule].self, from: data) else { return }
        rules = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder.iso.encode(rules) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
