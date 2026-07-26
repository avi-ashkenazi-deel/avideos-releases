import Foundation

/// Post-session editor data model.
///
/// Terminology used throughout Mac/PostEdit/:
/// - **Source time**: seconds on the common recording timeline shared by all
///   tracks (all `EditTrack` files start at t = 0, pre-aligned by import).
/// - **Timeline (edited) time**: seconds in the edited program, i.e. source
///   time with disabled clips removed. `LayoutCue.atTime` and
///   `Chapter.startTime` are expressed in *timeline* time, because they are
///   authored against the edited preview.
///
/// Everything in this file is a pure value type; the mutating helpers on
/// `EditDecisionList` are deterministic functions of their inputs and are the
/// primary unit-test surface of the module.

// MARK: - Clip

enum ClipLabel: String, Codable, Sendable, CaseIterable {
    case kept
    case cutManual
    case cutFlub
    case cutRetake
    case cutFiller
    case cutSilence
    case adlib

    var isCut: Bool {
        switch self {
        case .kept, .adlib: return false
        default: return true
        }
    }

    /// Cuts produced by automation (AI edit / auto-cleanup) as opposed to a
    /// user gesture. CompositionBuilder uses this to decide micro-fades,
    /// though in practice fades are applied at every join (see
    /// `CompositionBuilder`).
    var isAutomatedCut: Bool {
        switch self {
        case .cutFlub, .cutRetake, .cutFiller, .cutSilence: return true
        default: return false
        }
    }
}

struct Clip: Codable, Sendable, Identifiable, Equatable {
    var id: UUID
    /// Half-open in spirit, `ClosedRange` in type (per project convention):
    /// consecutive clips share their boundary value. Seconds, source time.
    var sourceRange: ClosedRange<Double>
    var enabled: Bool
    var label: ClipLabel

    init(id: UUID = UUID(),
         sourceRange: ClosedRange<Double>,
         enabled: Bool = true,
         label: ClipLabel = .kept) {
        self.id = id
        self.sourceRange = sourceRange
        self.enabled = enabled
        self.label = label
    }

    var duration: Double { sourceRange.upperBound - sourceRange.lowerBound }
}

// MARK: - Edit Decision List

/// Non-destructive EDL over the common source timeline.
///
/// Invariants (maintained by every mutating helper):
/// 1. `clips` is sorted by `sourceRange.lowerBound`.
/// 2. Clips tile the source domain exactly: `clips[i].sourceRange.upperBound
///    == clips[i+1].sourceRange.lowerBound`, first starts at 0, last ends at
///    the source duration the EDL was created with.
/// 3. No clip is shorter than `EditDecisionList.minimumClipDuration`.
///
/// Cutting never removes clips — it disables them, so they stay recoverable.
struct EditDecisionList: Codable, Sendable, Equatable {
    var clips: [Clip]

    /// Degenerate splits below this are refused (seconds).
    static let minimumClipDuration: Double = 0.001

    init(clips: [Clip]) {
        self.clips = clips
    }

    /// A fresh EDL: one enabled clip covering the whole source duration.
    static func initial(sourceDuration: Double) -> EditDecisionList {
        EditDecisionList(clips: [Clip(sourceRange: 0...max(sourceDuration, Self.minimumClipDuration))])
    }

    // MARK: Derived values

    var sourceDuration: Double { clips.last?.sourceRange.upperBound ?? 0 }

    var editedDuration: Double {
        clips.reduce(0) { $0 + ($1.enabled ? $1.duration : 0) }
    }

    /// The enabled clips in order, each paired with its start time on the
    /// edited timeline. This is the canonical iteration order for
    /// CompositionBuilder, chapter mapping and transcript mapping.
    func enabledSegments() -> [(clip: Clip, timelineStart: Double)] {
        var out: [(Clip, Double)] = []
        var acc = 0.0
        for clip in clips where clip.enabled {
            out.append((clip, acc))
            acc += clip.duration
        }
        return out
    }

    func clip(withID id: UUID) -> Clip? {
        clips.first { $0.id == id }
    }

    func clipIndex(containing sourceTime: Double) -> Int? {
        // Boundary values belong to the earlier clip except at 0.
        guard sourceTime >= 0, sourceTime <= sourceDuration else { return nil }
        // Binary search over lower bounds.
        var lo = 0, hi = clips.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if clips[mid].sourceRange.lowerBound <= sourceTime { lo = mid } else { hi = mid - 1 }
        }
        guard !clips.isEmpty else { return nil }
        // `lo` is the last clip starting at or before sourceTime.
        // A boundary time (== lowerBound of clip lo, lo > 0) maps to the
        // earlier clip when it equals that clip's upperBound; we prefer the
        // clip that *starts* here for editing intuition, except the exact
        // source end which belongs to the last clip.
        return lo
    }

    // MARK: Time mapping

    /// Source → edited timeline. Returns nil when the source time falls in a
    /// disabled (cut) region.
    func mapSourceToTimeline(_ sourceTime: Double) -> Double? {
        var acc = 0.0
        for clip in clips {
            if sourceTime < clip.sourceRange.upperBound || clip.id == clips.last?.id {
                guard sourceTime >= clip.sourceRange.lowerBound else { return nil }
                guard clip.enabled else { return nil }
                return acc + (sourceTime - clip.sourceRange.lowerBound)
            }
            if clip.enabled { acc += clip.duration }
        }
        return nil
    }

    /// Edited timeline → source. Total function: values are clamped into
    /// [0, editedDuration] first. Inverse of `mapSourceToTimeline` on the
    /// enabled domain.
    func mapTimelineToSource(_ timelineTime: Double) -> Double {
        let t = min(max(timelineTime, 0), editedDuration)
        var acc = 0.0
        var lastEnabled: Clip?
        for clip in clips where clip.enabled {
            if t <= acc + clip.duration {
                return clip.sourceRange.lowerBound + (t - acc)
            }
            acc += clip.duration
            lastEnabled = clip
        }
        return lastEnabled?.sourceRange.upperBound ?? 0
    }

    /// Nearest *enabled* source time to the given source time (identity when
    /// already enabled). Used when the playhead lands in a cut after an edit.
    func nearestEnabledSourceTime(to sourceTime: Double) -> Double {
        if let idx = clipIndex(containing: sourceTime), clips[idx].enabled {
            return sourceTime
        }
        var best: Double?
        for clip in clips where clip.enabled {
            let candidate = min(max(sourceTime, clip.sourceRange.lowerBound), clip.sourceRange.upperBound)
            if best == nil || abs(candidate - sourceTime) < abs(best! - sourceTime) {
                best = candidate
            }
        }
        return best ?? sourceTime
    }

    // MARK: Mutations (pure functions of the value)

    /// Splits the clip containing `sourceTime` into two clips at that time.
    /// Both halves keep the original enabled state and label; the right half
    /// gets a new identity. No-op (returns nil) when the time coincides with
    /// an existing boundary or would create a sub-millisecond clip.
    @discardableResult
    mutating func splitClip(at sourceTime: Double) -> (left: UUID, right: UUID)? {
        guard let idx = clipIndex(containing: sourceTime) else { return nil }
        let clip = clips[idx]
        let lower = clip.sourceRange.lowerBound
        let upper = clip.sourceRange.upperBound
        guard sourceTime - lower >= Self.minimumClipDuration,
              upper - sourceTime >= Self.minimumClipDuration else { return nil }
        var left = clip
        left.sourceRange = lower...sourceTime
        let right = Clip(sourceRange: sourceTime...upper, enabled: clip.enabled, label: clip.label)
        clips.replaceSubrange(idx...idx, with: [left, right])
        return (left.id, right.id)
    }

    /// Core cut primitive: carve `range` out of the program by splitting at
    /// its boundaries and disabling every clip inside it. Returns the ids of
    /// the clips that were disabled (for undo/preview change-sets).
    ///
    /// Already-disabled clips inside the range are left untouched (their
    /// original cut label is preserved).
    @discardableResult
    mutating func insertCut(_ range: ClosedRange<Double>, label: ClipLabel) -> [UUID] {
        let lower = max(0, min(range.lowerBound, sourceDuration))
        let upper = max(0, min(range.upperBound, sourceDuration))
        guard upper - lower >= Self.minimumClipDuration else { return [] }
        splitClip(at: lower)
        splitClip(at: upper)
        var changed: [UUID] = []
        for i in clips.indices {
            let c = clips[i]
            guard c.enabled,
                  c.sourceRange.lowerBound >= lower - Self.minimumClipDuration / 2,
                  c.sourceRange.upperBound <= upper + Self.minimumClipDuration / 2 else { continue }
            clips[i].enabled = false
            clips[i].label = label
            changed.append(c.id)
        }
        return changed
    }

    /// User-facing delete. Same as `insertCut` with a manual label default.
    @discardableResult
    mutating func deleteRange(_ range: ClosedRange<Double>, label: ClipLabel = .cutManual) -> [UUID] {
        insertCut(range, label: label)
    }

    /// Re-enables a previously cut clip.
    @discardableResult
    mutating func recoverClip(id: UUID) -> Bool {
        guard let idx = clips.firstIndex(where: { $0.id == id }) else { return false }
        guard !clips[idx].enabled else { return false }
        clips[idx].enabled = true
        clips[idx].label = .kept
        return true
    }

    @discardableResult
    mutating func setEnabled(_ enabled: Bool, id: UUID, label: ClipLabel = .cutManual) -> Bool {
        guard let idx = clips.firstIndex(where: { $0.id == id }) else { return false }
        clips[idx].enabled = enabled
        clips[idx].label = enabled ? .kept : label
        return true
    }

    /// Optional hygiene pass: merges adjacent clips with identical
    /// enabled/label state. Never called implicitly — merging discards the
    /// ability to recover individual cuts, so the UI offers it explicitly.
    mutating func coalesce() {
        var merged: [Clip] = []
        for clip in clips {
            if var last = merged.last,
               last.enabled == clip.enabled,
               last.label == clip.label,
               abs(last.sourceRange.upperBound - clip.sourceRange.lowerBound) < Self.minimumClipDuration / 2 {
                last.sourceRange = last.sourceRange.lowerBound...clip.sourceRange.upperBound
                merged[merged.count - 1] = last
            } else {
                merged.append(clip)
            }
        }
        clips = merged
    }
}

// MARK: - Layout

enum ProgramLayout: Sendable, Equatable, Hashable {
    case fullScreen(participantId: String?)
    case sideBySide
    case grid
    case verticalStacked
    case activeSpeaker

    var displayName: String {
        switch self {
        case .fullScreen: return "Full Screen"
        case .sideBySide: return "Side by Side"
        case .grid: return "Grid"
        case .verticalStacked: return "Vertical"
        case .activeSpeaker: return "Active Speaker"
        }
    }

    var systemImageName: String {
        switch self {
        case .fullScreen: return "rectangle"
        case .sideBySide: return "rectangle.split.2x1"
        case .grid: return "square.grid.2x2"
        case .verticalStacked: return "rectangle.split.1x2"
        case .activeSpeaker: return "person.wave.2"
        }
    }
}

extension ProgramLayout: Codable {
    private enum CodingKeys: String, CodingKey { case kind, participantId }
    private enum Kind: String, Codable {
        case fullScreen, sideBySide, grid, verticalStacked, activeSpeaker
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .fullScreen:
            self = .fullScreen(participantId: try container.decodeIfPresent(String.self, forKey: .participantId))
        case .sideBySide: self = .sideBySide
        case .grid: self = .grid
        case .verticalStacked: self = .verticalStacked
        case .activeSpeaker: self = .activeSpeaker
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .fullScreen(let pid):
            try container.encode(Kind.fullScreen, forKey: .kind)
            try container.encodeIfPresent(pid, forKey: .participantId)
        case .sideBySide: try container.encode(Kind.sideBySide, forKey: .kind)
        case .grid: try container.encode(Kind.grid, forKey: .kind)
        case .verticalStacked: try container.encode(Kind.verticalStacked, forKey: .kind)
        case .activeSpeaker: try container.encode(Kind.activeSpeaker, forKey: .kind)
        }
    }
}

/// A layout change anchored to the *source* timeline, so cuts elsewhere in
/// the program never detach a layout from the content it was set on. The
/// layout applies from `atTime` until the next cue (or program end).
/// Consumers working in edited time (CompositionBuilder) map cues through
/// the EDL first.
struct LayoutCue: Codable, Sendable, Identifiable, Equatable {
    var id: UUID
    /// Source-timeline seconds.
    var atTime: Double
    var layout: ProgramLayout

    init(id: UUID = UUID(), atTime: Double, layout: ProgramLayout) {
        self.id = id
        self.atTime = atTime
        self.layout = layout
    }
}

extension Array where Element == LayoutCue {
    /// The layout in effect at a given time. Ordered lookup in whatever
    /// timebase the cues in this array carry — pass a source time for
    /// project cues, or an edited time for cues already mapped through
    /// the EDL.
    func layout(at time: Double, fallback: ProgramLayout = .grid) -> ProgramLayout {
        let sorted = self.sorted { $0.atTime < $1.atTime }
        var current = fallback
        for cue in sorted {
            if cue.atTime <= time { current = cue.layout } else { break }
        }
        return current
    }
}

// MARK: - Chapter

struct Chapter: Codable, Sendable, Identifiable, Equatable {
    var id: UUID
    var title: String
    /// Edited-timeline seconds.
    var startTime: Double

    init(id: UUID = UUID(), title: String, startTime: Double) {
        self.id = id
        self.title = title
        self.startTime = startTime
    }
}

// MARK: - EditProject

struct EditProject: Codable, Sendable, Identifiable, Equatable {
    static let currentSchemaVersion = 1

    var id: UUID
    var sessionId: String
    var name: String
    var tracks: [EditTrack]
    var edl: EditDecisionList
    var layoutCues: [LayoutCue]
    var captions: CaptionStyle?
    var transcript: Transcript?
    var chapters: [Chapter]
    var schemaVersion: Int

    /// `edl` defaults to a fresh full-length EDL derived from the tracks, so
    /// callers (e.g. StudioController.openEditor) can write
    /// `EditProject(sessionId:name:tracks:)` without building one by hand.
    init(id: UUID = UUID(),
         sessionId: String,
         name: String,
         tracks: [EditTrack],
         edl: EditDecisionList? = nil,
         layoutCues: [LayoutCue] = [],
         captions: CaptionStyle? = nil,
         transcript: Transcript? = nil,
         chapters: [Chapter] = [],
         schemaVersion: Int = EditProject.currentSchemaVersion) {
        self.id = id
        self.sessionId = sessionId
        self.name = name
        self.tracks = tracks
        self.edl = edl ?? .initial(sourceDuration: tracks.map(\.duration).max() ?? 0)
        self.layoutCues = layoutCues
        self.captions = captions
        self.transcript = transcript
        self.chapters = chapters
        self.schemaVersion = schemaVersion
    }

    /// Entry point used by StudioController: build a fresh project over a set
    /// of imported, drift-corrected tracks (all sharing t = 0).
    static func make(sessionId: String, name: String, tracks: [EditTrack]) -> EditProject {
        let duration = tracks.map(\.duration).max() ?? 0
        var project = EditProject(
            sessionId: sessionId,
            name: name,
            tracks: tracks,
            edl: .initial(sourceDuration: duration)
        )
        let participants = Set(tracks.filter { $0.kind == .video }.map(\.participantId))
        project.layoutCues = [LayoutCue(atTime: 0, layout: participants.count > 1 ? .grid : .fullScreen(participantId: participants.first))]
        return project
    }

    var sourceDuration: Double { edl.sourceDuration }
    var editedDuration: Double { edl.editedDuration }

    var audioTracks: [EditTrack] { tracks.filter { $0.kind == .audio } }
    var videoTracks: [EditTrack] { tracks.filter { $0.kind == .video } }

    func track(withID id: String) -> EditTrack? { tracks.first { $0.id == id } }

    func participantName(for participantId: String) -> String {
        tracks.first { $0.participantId == participantId }?.participantName ?? participantId
    }
}
