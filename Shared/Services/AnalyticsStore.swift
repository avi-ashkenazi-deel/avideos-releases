import Foundation
import Combine

/// Listening totals for one sender (or article source).
struct SenderStat: Codable, Sendable, Identifiable {
    var name: String
    var emails: Int
    var seconds: Double
    var words: Int

    var id: String { name }
}

/// Everything the analytics screen reports.
struct ListeningStats: Codable, Sendable {
    var emailsListened = 0
    var words = 0
    var listeningSeconds: Double = 0
    /// Characters sent to ElevenLabs (the unit it bills on). 0 when only the
    /// free on-device voice has been used.
    var elevenLabsCharacters = 0
    /// Keyed by sender address (falls back to display name).
    var bySender: [String: SenderStat] = [:]
}

/// Tracks how much the listener has listened — emails, words, time — plus
/// ElevenLabs usage for cost, and who they listen to most. Persisted in the
/// shared container.
@MainActor
final class AnalyticsStore: ObservableObject {

    static let shared = AnalyticsStore()

    /// Rough ElevenLabs price per 1,000 characters (USD). Their plans vary, so
    /// the cost shown is an estimate; the character count is the hard number.
    static let approxCostPerThousandChars = 0.30

    @Published private(set) var stats = ListeningStats()

    private let fileURL: URL

    init(containerURL: URL = AppGroup.containerURL) {
        self.fileURL = containerURL.appendingPathComponent("analytics.json")
        load()
    }

    /// Top senders by total listening time, most first.
    var topSenders: [SenderStat] {
        stats.bySender.values.sorted { $0.seconds > $1.seconds }
    }

    var estimatedElevenLabsCost: Double {
        Double(stats.elevenLabsCharacters) / 1000 * Self.approxCostPerThousandChars
    }

    /// Record a finished email/article: counts it once, with its words, the time
    /// actually spent listening, and who it was from.
    func recordCompleted(from: EmailAddress, words: Int, seconds: Double) {
        stats.emailsListened += 1
        stats.words += words
        stats.listeningSeconds += max(seconds, 0)

        let key = from.address.isEmpty ? from.displayName : from.address
        var sender = stats.bySender[key]
            ?? SenderStat(name: from.displayName, emails: 0, seconds: 0, words: 0)
        sender.name = from.displayName
        sender.emails += 1
        sender.seconds += max(seconds, 0)
        sender.words += words
        stats.bySender[key] = sender

        save()
    }

    /// Add characters billed by a successful ElevenLabs synthesis request.
    func recordElevenLabsCharacters(_ count: Int) {
        guard count > 0 else { return }
        stats.elevenLabsCharacters += count
        save()
    }

    func reset() {
        stats = ListeningStats()
        save()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode(ListeningStats.self, from: data) else {
            return
        }
        stats = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(stats) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
