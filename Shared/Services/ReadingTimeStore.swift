import Foundation
import Combine

/// Estimates reading time for email/article text.
enum ReadingTime {
    /// Typical adult reading speed; used for the "X min read" estimate.
    static let wordsPerMinute = 200.0

    static func minutes(forText text: String) -> Int {
        let words = text.split { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" }.count
        guard words > 0 else { return 1 }
        return max(1, Int((Double(words) / wordsPerMinute).rounded()))
    }

    /// Estimate from an email whose body is loaded; nil when only metadata is
    /// known (e.g. an inbox-list row that hasn't been fetched in full yet).
    static func minutes(for email: Email) -> Int? {
        if let text = email.bodyText, !text.isEmpty {
            return minutes(forText: text)
        }
        if let html = email.bodyHTML, !html.isEmpty {
            let stripped = html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            return minutes(forText: stripped)
        }
        return nil
    }
}

/// Caches estimated reading minutes per message id in the shared container, so
/// the inbox can show "X min read" without re-fetching bodies on every launch.
@MainActor
final class ReadingTimeStore: ObservableObject {

    static let shared = ReadingTimeStore()

    @Published private(set) var byID: [String: Int] = [:]

    private let fileURL: URL

    init(containerURL: URL = AppGroup.containerURL) {
        self.fileURL = containerURL.appendingPathComponent("reading-times.json")
        load()
    }

    func minutes(for id: String) -> Int? { byID[id] }

    func record(id: String, minutes: Int) {
        guard byID[id] != minutes else { return }
        byID[id] = minutes
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([String: Int].self, from: data) else {
            return
        }
        byID = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(byID) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
