import Foundation
import os

/// JSON persistence for teleprompter scripts, mirroring `ProjectStore`:
/// `~/Library/Application Support/Streamit/Scripts/<uuid>.avscript`.
final class ScriptStore {
    static let shared = ScriptStore()

    let directory: URL

    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "teleprompter")
    private let mostRecentKey = "Streamit.Teleprompter.MostRecentScriptID"
    private let defaults: UserDefaults

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init(directory: URL? = nil, defaults: UserDefaults = .standard) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.directory = directory ?? base.appendingPathComponent("Streamit/Scripts", isDirectory: true)
        self.defaults = defaults
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    private func url(for id: UUID) -> URL {
        directory.appendingPathComponent("\(id.uuidString).avscript")
    }

    /// All saved scripts, most recently modified first.
    func list() -> [ScriptDocument] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        return files
            .filter { $0.pathExtension == "avscript" }
            .sorted { a, b in
                let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return da > db
            }
            .compactMap { url in
                do {
                    return try decoder.decode(ScriptDocument.self, from: Data(contentsOf: url))
                } catch {
                    log.error("Skipping unreadable script at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    return nil
                }
            }
    }

    func load(id: UUID) throws -> ScriptDocument {
        try decoder.decode(ScriptDocument.self, from: Data(contentsOf: url(for: id)))
    }

    func save(_ script: ScriptDocument) throws {
        let data = try encoder.encode(script)
        try data.write(to: url(for: script.id), options: .atomic)
        log.debug("Saved script \(script.id, privacy: .public) (\(script.sections.count) sections)")
    }

    func delete(id: UUID) throws {
        try FileManager.default.removeItem(at: url(for: id))
        if mostRecentID == id {
            defaults.removeObject(forKey: mostRecentKey)
        }
    }

    // MARK: - Most-recent tracking

    var mostRecentID: UUID? {
        defaults.string(forKey: mostRecentKey).flatMap(UUID.init(uuidString:))
    }

    /// Call whenever a script is loaded into the prompter so the app can
    /// restore it on next launch.
    func markOpened(_ id: UUID) {
        defaults.set(id.uuidString, forKey: mostRecentKey)
    }

    /// Last-opened script if it still exists, else the newest on disk.
    func loadMostRecent() -> ScriptDocument? {
        if let id = mostRecentID, let script = try? load(id: id) {
            return script
        }
        return list().first
    }
}
