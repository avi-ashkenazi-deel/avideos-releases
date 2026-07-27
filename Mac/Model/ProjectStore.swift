import Foundation

/// Loads and saves projects as pretty-printed JSON documents in
/// `~/Library/Application Support/Streamit/Projects/<uuid>.avproj`.
/// JSON (not CoreData/SwiftData) because the document is small, deeply
/// nested, enum-heavy, and benefits from being diffable.
final class ProjectStore {
    enum StoreError: LocalizedError {
        case newerSchema(found: Int, supported: Int)

        var errorDescription: String? {
            switch self {
            case .newerSchema(let found, let supported):
                "This project was saved by a newer version of streamit (schema \(found); this app reads up to \(supported))."
            }
        }
    }

    static let shared = ProjectStore()

    let directory: URL

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

    /// Debounce bookkeeping: saves are cheap but the UI mutates the document
    /// continuously while dragging.
    private var pendingSave: DispatchWorkItem?
    private let saveQueue = DispatchQueue(label: "com.aviashkenazi.streamit.projectstore", qos: .utility)

    init(directory: URL? = nil) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.directory = directory ?? base.appendingPathComponent("Streamit/Projects", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    private func url(for id: UUID) -> URL {
        directory.appendingPathComponent("\(id.uuidString).avproj")
    }

    func listProjects() -> [Project] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        return files
            .filter { $0.pathExtension == "avproj" }
            .compactMap { try? load(from: $0) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func load(id: UUID) throws -> Project {
        try load(from: url(for: id))
    }

    private func load(from url: URL) throws -> Project {
        let data = try Data(contentsOf: url)
        // Peek at the version before full decode so we can migrate or refuse.
        struct VersionPeek: Codable { let schemaVersion: Int? }
        let peek = try decoder.decode(VersionPeek.self, from: data)
        let version = peek.schemaVersion ?? 1
        guard version <= ModelSchema.version else {
            throw StoreError.newerSchema(found: version, supported: ModelSchema.version)
        }
        let migrated = try migrate(data: data, from: version)
        return try decoder.decode(Project.self, from: migrated)
    }

    /// Dumb migration switch — grows one case per schema bump.
    private func migrate(data: Data, from version: Int) throws -> Data {
        switch version {
        case ModelSchema.version:
            return data
        default:
            // Schema 1 is the first release; nothing older exists in the wild.
            return data
        }
    }

    func save(_ project: Project) throws {
        let data = try encoder.encode(project)
        try data.write(to: url(for: project.id), options: .atomic)
    }

    /// Coalesces rapid mutations (drag gestures) into one disk write.
    func saveDebounced(_ project: Project, delay: TimeInterval = 0.75) {
        pendingSave?.cancel()
        let work = DispatchWorkItem { [weak self] in
            try? self?.save(project)
        }
        pendingSave = work
        saveQueue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func delete(id: UUID) throws {
        try FileManager.default.removeItem(at: url(for: id))
    }

    /// Loads the most recently modified project or creates the starter.
    func loadMostRecentOrStarter() -> Project {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        let newest = files
            .filter { $0.pathExtension == "avproj" }
            .max { a, b in
                let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return da < db
            }
        if let newest, let project = try? load(from: newest) {
            return project
        }
        let starter = Project.starter()
        try? save(starter)
        return starter
    }
}
