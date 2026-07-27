import Foundation
import Observation
import AppKit
import os.log

/// Owns the mutable `EditProject`, persists it as JSON, and integrates edits
/// with `UndoManager` via whole-value snapshots of the undoable state
/// (EDL + layout cues + chapters).
///
/// File format: pretty-printed JSON at
/// `~/Library/Application Support/Streamit/Projects/Edits/{id}.avedit`.
@Observable
@MainActor
final class EditProjectStore {
    private static let logger = Logger(subsystem: "com.aviashkenazi.streamit", category: "EditProjectStore")

    var project: EditProject
    let undoManager: UndoManager

    /// Bumped on every undoable mutation; observers (PreviewPlayer,
    /// TranscriptEditModel, TimelineViewModel) key their rebuilds off it.
    private(set) var editGeneration: Int = 0

    private var saveTask: Task<Void, Never>?

    init(project: EditProject, undoManager: UndoManager = UndoManager()) {
        self.project = project
        self.undoManager = undoManager
    }

    // MARK: - Locations

    // Both are pure path arithmetic over no shared state, and `write` — which
    // runs on a detached task so a save never blocks a keystroke — needs them.
    // Isolating them to the main actor was an accident of the class annotation.
    nonisolated static var directoryURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Streamit/Projects/Edits", isDirectory: true)
    }

    nonisolated static func fileURL(for id: UUID) -> URL {
        directoryURL.appendingPathComponent("\(id.uuidString).avedit")
    }

    // MARK: - Persistence

    static func load(id: UUID) throws -> EditProject {
        let data = try Data(contentsOf: fileURL(for: id))
        return try decoder.decode(EditProject.self, from: data)
    }

    static func loadAll() -> [EditProject] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.pathExtension == "avedit" }.compactMap { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? decoder.decode(EditProject.self, from: data)
        }
    }

    func save() {
        // Debounced, off the main path.
        saveTask?.cancel()
        let snapshot = project
        saveTask = Task.detached(priority: .utility) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            do {
                try Self.write(snapshot)
            } catch {
                Self.logger.error("save failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    nonisolated static func write(_ project: EditProject) throws {
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let data = try encoder.encode(project)
        try data.write(to: fileURL(for: project.id), options: .atomic)
    }

    private nonisolated static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }

    private nonisolated static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }

    // MARK: - Undoable mutation

    /// The state captured for undo. Transcript and tracks are not undoable
    /// (they are derived/imported data); captions style changes are cheap and
    /// included for convenience.
    struct UndoSnapshot: Sendable {
        var edl: EditDecisionList
        var layoutCues: [LayoutCue]
        var chapters: [Chapter]
        var captions: CaptionStyle?
    }

    private var snapshot: UndoSnapshot {
        UndoSnapshot(edl: project.edl, layoutCues: project.layoutCues, chapters: project.chapters, captions: project.captions)
    }

    private func restore(_ s: UndoSnapshot) {
        let redoSnapshot = snapshot
        undoManager.registerUndo(withTarget: self) { store in
            MainActor.assumeIsolated { store.restore(redoSnapshot) }
        }
        project.edl = s.edl
        project.layoutCues = s.layoutCues
        project.chapters = s.chapters
        project.captions = s.captions
        editGeneration += 1
        save()
    }

    /// Perform an undoable edit. All EDL/cue/chapter mutations in the UI go
    /// through here so a single ⌘Z reverts one gesture (or one applied AI
    /// change-set) atomically.
    func performEdit(_ actionName: String, _ body: (inout EditProject) -> Void) {
        let before = snapshot
        undoManager.registerUndo(withTarget: self) { store in
            MainActor.assumeIsolated { store.restore(before) }
        }
        undoManager.setActionName(actionName)
        body(&project)
        editGeneration += 1
        save()
    }

    /// Non-undoable mutation (transcript arrival, track metadata, etc.).
    func updateDerivedData(_ body: (inout EditProject) -> Void) {
        body(&project)
        save()
    }
}
