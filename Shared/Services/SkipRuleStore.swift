import Foundation
import Combine

/// A phrase the listener never wants read aloud — optionally scoped to one
/// sender. Built for the recurring chrome newsletters repeat in every issue
/// (Substack's "Read in app", "Like / Comment / Restack", …).
struct SkipRule: Identifiable, Codable, Hashable, Sendable {
    var id: String = UUID().uuidString
    /// The text to match (the sentence the listener chose to skip).
    var phrase: String
    /// Lowercased *full* sender address this applies to; empty = every sender.
    /// (Previously the domain — too broad for Substack, where every author sends
    /// from `…@substack.com`; the full address scopes per author/publication.)
    var sender: String
    /// Sender display name, just so the rules list reads nicely.
    var label: String

    // Keep the original on-disk key so existing rules still decode.
    enum CodingKeys: String, CodingKey {
        case id, phrase, label
        case sender = "senderDomain"
    }

    func matches(_ text: String, fromAddress: String) -> Bool {
        if !sender.isEmpty, sender != fromAddress.lowercased() {
            return false
        }
        let needle = SkipRuleStore.normalize(phrase)
        guard needle.count >= 3 else { return false }
        return SkipRuleStore.normalize(text).contains(needle)
    }

    var scopeDescription: String {
        if sender.isEmpty { return "All senders" }
        return label.isEmpty ? sender : label
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

    /// Add a rule (deduped by phrase + scope). `sender` is the full sender address
    /// to scope to, or "" for every sender. Returns false if it already exists.
    @discardableResult
    func add(phrase: String, sender: String, label: String) -> Bool {
        let trimmed = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }
        let addr = sender.lowercased()
        let exists = rules.contains {
            $0.sender == addr && Self.normalize($0.phrase) == Self.normalize(trimmed)
        }
        guard !exists else { return false }
        rules.insert(SkipRule(phrase: trimmed, sender: addr, label: label), at: 0)
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

    // `nonisolated` so `SkipRule.matches` (a plain struct method) can call them
    // without hopping to the main actor — they're pure string functions.
    nonisolated static func domain(of address: String) -> String {
        address.split(separator: "@").last.map { $0.lowercased() } ?? ""
    }

    nonisolated static func normalize(_ s: String) -> String {
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
