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

/// One day's listening, keyed by local calendar day — the raw series the
/// day/week/month breakdown chart aggregates from.
struct DayEntry: Codable, Sendable {
    var seconds: Double = 0
    var emails: Int = 0
    var words: Int = 0
}

/// A period on the breakdown chart (one day, week, or month) with its total.
struct ListeningBucket: Identifiable, Sendable {
    let date: Date
    let label: String
    let seconds: Double
    let emails: Int
    var id: Date { date }
    var minutes: Double { seconds / 60 }
}

/// The granularity the listener can switch the breakdown chart between.
enum AnalyticsRange: String, CaseIterable, Identifiable, Sendable {
    case day, week, month
    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: return "Day"
        case .week: return "Week"
        case .month: return "Month"
        }
    }

    /// How many periods to show (a couple of weeks of days, a couple of months of
    /// weeks, half a year of months).
    var bucketCount: Int {
        switch self {
        case .day: return 14
        case .week: return 8
        case .month: return 6
        }
    }
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

    /// Per-day listening totals (keyed "yyyy-MM-dd", local). Kept in its own file
    /// so adding this series never risks decoding the existing totals.
    @Published private(set) var daily: [String: DayEntry] = [:]

    private let fileURL: URL
    private let dailyURL: URL

    init(containerURL: URL = AppGroup.containerURL) {
        self.fileURL = containerURL.appendingPathComponent("analytics.json")
        self.dailyURL = containerURL.appendingPathComponent("analytics-daily.json")
        load()
    }

    /// Local "yyyy-MM-dd" day key for grouping the series.
    private static let dayKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

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

        // Add to today's bucket for the day/week/month breakdown.
        let dayKey = Self.dayKeyFormatter.string(from: Date())
        var day = daily[dayKey] ?? DayEntry()
        day.seconds += max(seconds, 0)
        day.emails += 1
        day.words += words
        daily[dayKey] = day

        save()
        saveDaily()
    }

    /// Listening totals bucketed into the last N days / weeks / months (oldest →
    /// newest), including empty periods so the chart's axis stays continuous.
    func buckets(for range: AnalyticsRange, now: Date = Date()) -> [ListeningBucket] {
        let cal = Calendar.current
        let component: Calendar.Component
        let anchor: Date
        switch range {
        case .day:
            component = .day
            anchor = cal.startOfDay(for: now)
        case .week:
            component = .weekOfYear
            anchor = cal.dateInterval(of: .weekOfYear, for: now)?.start ?? cal.startOfDay(for: now)
        case .month:
            component = .month
            anchor = cal.dateInterval(of: .month, for: now)?.start ?? cal.startOfDay(for: now)
        }
        return (0..<range.bucketCount).reversed().compactMap { back -> ListeningBucket? in
            guard let start = cal.date(byAdding: component, value: -back, to: anchor),
                  let end = cal.date(byAdding: component, value: 1, to: start) else { return nil }
            var secs = 0.0, mails = 0
            for (key, entry) in daily {
                guard let d = Self.dayKeyFormatter.date(from: key), d >= start, d < end else { continue }
                secs += entry.seconds
                mails += entry.emails
            }
            return ListeningBucket(date: start, label: Self.label(for: start, range: range),
                                   seconds: secs, emails: mails)
        }
    }

    private static func label(for date: Date, range: AnalyticsRange) -> String {
        let f = DateFormatter()
        f.locale = .current
        switch range {
        case .day:   f.dateFormat = "d"
        case .week:  f.dateFormat = "d MMM"
        case .month: f.dateFormat = "MMM"
        }
        return f.string(from: date)
    }

    /// Add characters billed by a successful ElevenLabs synthesis request.
    func recordElevenLabsCharacters(_ count: Int) {
        guard count > 0 else { return }
        stats.elevenLabsCharacters += count
        save()
    }

    func reset() {
        stats = ListeningStats()
        daily = [:]
        save()
        saveDaily()
    }

    // MARK: - Persistence

    private func load() {
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(ListeningStats.self, from: data) {
            stats = decoded
        }
        if let data = try? Data(contentsOf: dailyURL),
           let decoded = try? JSONDecoder().decode([String: DayEntry].self, from: data) {
            daily = decoded
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(stats) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private func saveDaily() {
        guard let data = try? JSONEncoder().encode(daily) else { return }
        try? data.write(to: dailyURL, options: .atomic)
    }
}
