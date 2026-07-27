import Foundation

/// Post-session editor data model.
///
/// Terminology used throughout Mac/PostEdit/:
/// - **Source time**: seconds on the common recording timeline shared by all
///   tracks (all `EditTrack` files start at t = 0, pre-aligned by import).
/// - **Timeline (edited) time**: seconds in the edited program, i.e. source
///   time with disabled clips removed. `Chapter.startTime` is expressed in
///   *timeline* time, because chapters are authored against the edited
///   program. `LayoutCue.atTime` is *source* time instead, so a cut made
///   elsewhere never detaches a layout from the content it was set on;
///   CompositionBuilder maps cues through the EDL when it builds
///   instructions.
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

/// Non-destructive EDL: an ordered **sequence** of segments taken from the
/// common source timeline.
///
/// Invariants (maintained by every mutating helper):
/// 1. **Array order is timeline order.** `clips[0]` plays first. This is the
///    only ordering rule — source ranges may appear in any order, may repeat,
///    and need not cover the source.
/// 2. Every `sourceRange` lies within `0...sourceDuration`.
/// 3. No clip is shorter than `EditDecisionList.minimumClipDuration`.
///
/// Cutting never removes clips — it disables them, so they stay recoverable.
/// (`remove(clipID:)` is the one hard delete, and only for duplicates.)
///
/// **A source time can now map to zero, one, or many timeline positions.**
/// A straight recording maps 1:1; duplicate a moment and it has two. Callers
/// that need a single answer use `mapSourceToTimeline` (first occurrence);
/// callers that need them all use `timelinePositions(ofSource:)`.
///
/// An EDL produced before reordering existed — clips sorted and tiling the
/// source exactly — is a valid sequence under these rules and behaves
/// identically, so old projects need no migration.
struct EditDecisionList: Codable, Sendable, Equatable {
    var clips: [Clip]

    /// The length of the underlying recording. Stored rather than derived:
    /// once clips can be reordered or trimmed, `clips.last.upperBound` is no
    /// longer the end of the source.
    private var storedSourceDuration: Double?

    /// Degenerate splits below this are refused (seconds).
    static let minimumClipDuration: Double = 0.001

    init(clips: [Clip], sourceDuration: Double? = nil) {
        self.clips = clips
        self.storedSourceDuration = sourceDuration
    }

    enum CodingKeys: String, CodingKey {
        case clips
        case storedSourceDuration
    }

    /// A fresh EDL: one enabled clip covering the whole source duration.
    static func initial(sourceDuration: Double) -> EditDecisionList {
        let duration = max(sourceDuration, Self.minimumClipDuration)
        return EditDecisionList(clips: [Clip(sourceRange: 0...duration)],
                                sourceDuration: duration)
    }

    // MARK: Derived values

    /// Falls back to the furthest source point any clip reaches, which is what
    /// pre-sequence documents (and hand-built EDLs) imply.
    var sourceDuration: Double {
        storedSourceDuration ?? clips.map(\.sourceRange.upperBound).max() ?? 0
    }

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

    /// Index of the first clip whose source range contains `sourceTime`.
    ///
    /// A linear scan now: clips are ordered by timeline position, not source
    /// position, so a binary search over lower bounds is no longer valid. With
    /// duplicates there may be several matches and this returns the earliest
    /// in the program.
    func clipIndex(containing sourceTime: Double) -> Int? {
        guard sourceTime >= 0, sourceTime <= sourceDuration else { return nil }
        if let exact = clips.firstIndex(where: { $0.sourceRange.contains(sourceTime) }) {
            return exact
        }
        // The exact source end sits on a clip's closed upper bound; tolerate
        // floating-point drift at boundaries rather than reporting "nowhere".
        return clips.firstIndex {
            sourceTime >= $0.sourceRange.lowerBound - Self.minimumClipDuration
                && sourceTime <= $0.sourceRange.upperBound + Self.minimumClipDuration
        }
    }

    // MARK: Time mapping

    /// Source → edited timeline, **first occurrence**. Returns nil when the
    /// source time is cut, or is not in the program at all.
    ///
    /// Since a moment can appear more than once, "first" means earliest in the
    /// program — the right answer for seeking to a word or placing a chapter.
    /// Use `timelinePositions(ofSource:)` when every occurrence matters.
    func mapSourceToTimeline(_ sourceTime: Double) -> Double? {
        timelinePositions(ofSource: sourceTime).first
    }

    /// Every timeline position at which `sourceTime` plays, in program order.
    /// Empty when the moment is entirely cut.
    func timelinePositions(ofSource sourceTime: Double) -> [Double] {
        var out: [Double] = []
        var acc = 0.0
        for clip in clips {
            guard clip.enabled else { continue }
            if sourceTime >= clip.sourceRange.lowerBound,
               sourceTime <= clip.sourceRange.upperBound {
                out.append(acc + (sourceTime - clip.sourceRange.lowerBound))
            }
            acc += clip.duration
        }
        return out
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
        return splitClip(atIndex: idx, sourceTime: sourceTime)
    }

    /// Splits whichever segment is playing at `timelineTime`. Unambiguous even
    /// when a moment appears more than once, which is why the playhead-driven
    /// "Split" command uses this rather than the source-time version.
    @discardableResult
    mutating func splitClip(atTimelineTime timelineTime: Double) -> (left: UUID, right: UUID)? {
        var acc = 0.0
        for (index, clip) in clips.enumerated() {
            guard clip.enabled else { continue }
            if timelineTime < acc + clip.duration {
                return splitClip(atIndex: index,
                                 sourceTime: clip.sourceRange.lowerBound + (timelineTime - acc))
            }
            acc += clip.duration
        }
        return nil
    }

    /// Splits the clip at `index`, keeping both halves adjacent in the
    /// sequence so the program order is unchanged.
    @discardableResult
    private mutating func splitClip(atIndex index: Int,
                                    sourceTime: Double) -> (left: UUID, right: UUID)? {
        guard clips.indices.contains(index) else { return nil }
        let clip = clips[index]
        let lower = clip.sourceRange.lowerBound
        let upper = clip.sourceRange.upperBound
        guard sourceTime - lower >= Self.minimumClipDuration,
              upper - sourceTime >= Self.minimumClipDuration else { return nil }
        var left = clip
        left.sourceRange = lower...sourceTime
        let right = Clip(sourceRange: sourceTime...upper, enabled: clip.enabled, label: clip.label)
        clips.replaceSubrange(index...index, with: [left, right])
        return (left.id, right.id)
    }

    /// Core cut primitive: carve `range` out of the program by splitting at
    /// its boundaries and disabling every segment inside it. Returns the ids
    /// of the clips that were disabled (for undo/preview change-sets).
    ///
    /// Already-disabled clips inside the range are left untouched (their
    /// original cut label is preserved). If the moment appears several times
    /// in the program, **every** occurrence is cut — cutting a word in the
    /// transcript should not leave a copy of it playing elsewhere.
    @discardableResult
    mutating func insertCut(_ range: ClosedRange<Double>, label: ClipLabel) -> [UUID] {
        let lower = max(0, min(range.lowerBound, sourceDuration))
        let upper = max(0, min(range.upperBound, sourceDuration))
        guard upper - lower >= Self.minimumClipDuration else { return [] }

        let tolerance = Self.minimumClipDuration / 2
        var changed: [UUID] = []
        var index = 0
        // Walk the sequence, splitting any segment that straddles a boundary
        // and disabling the ones that end up wholly inside. Splitting mutates
        // the array, so this walks by index rather than iterating a snapshot.
        while index < clips.count {
            let clip = clips[index]
            let clipLower = clip.sourceRange.lowerBound
            let clipUpper = clip.sourceRange.upperBound

            // No overlap with the cut, or already cut: leave it alone.
            guard clip.enabled,
                  clipUpper > lower + tolerance,
                  clipLower < upper - tolerance else {
                index += 1
                continue
            }

            if clipLower < lower - tolerance {
                // Straddles the start: keep the head, re-examine the tail.
                if splitClip(atIndex: index, sourceTime: lower) != nil {
                    index += 1
                    continue
                }
            } else if clipUpper > upper + tolerance {
                // Straddles the end: split and re-examine the head, which is
                // now wholly inside the cut.
                if splitClip(atIndex: index, sourceTime: upper) != nil {
                    continue
                }
            }

            clips[index].enabled = false
            clips[index].label = label
            changed.append(clips[index].id)
            index += 1
        }
        return changed
    }

    // MARK: Sequence edits

    /// Drag-to-extend. Sets a segment's source range, clamped to the recording
    /// and to the minimum duration. A clip can grow back into material a
    /// neighbouring cut had taken — extending is not limited to what the clip
    /// covered when it was created.
    @discardableResult
    mutating func trim(clipID: UUID, to newRange: ClosedRange<Double>) -> Bool {
        guard let index = clips.firstIndex(where: { $0.id == clipID }) else { return false }
        let lower = max(0, min(newRange.lowerBound, sourceDuration))
        let upper = max(0, min(newRange.upperBound, sourceDuration))
        guard upper - lower >= Self.minimumClipDuration else { return false }
        clips[index].sourceRange = lower...upper
        return true
    }

    /// Moves a segment to a new position in the program. `destinationIndex` is
    /// interpreted against the sequence *after* the clip is lifted out, which
    /// is what a drag-and-drop reorder means.
    @discardableResult
    mutating func move(clipID: UUID, toIndex destinationIndex: Int) -> Bool {
        guard let index = clips.firstIndex(where: { $0.id == clipID }) else { return false }
        let clip = clips.remove(at: index)
        let target = min(max(destinationIndex, 0), clips.count)
        clips.insert(clip, at: target)
        return index != target
    }

    /// Copies a segment and places the copy directly after the original, so a
    /// moment can play twice. The copy is a new identity but the same source.
    @discardableResult
    mutating func duplicate(clipID: UUID) -> UUID? {
        guard let index = clips.firstIndex(where: { $0.id == clipID }) else { return nil }
        let original = clips[index]
        let copy = Clip(sourceRange: original.sourceRange,
                        enabled: original.enabled,
                        label: original.label)
        clips.insert(copy, at: index + 1)
        return copy.id
    }

    /// Hard-deletes a segment. Unlike cutting, this is **not** recoverable, so
    /// it is meant for removing a duplicate rather than editing the
    /// conversation. Refuses to empty the sequence.
    @discardableResult
    mutating func remove(clipID: UUID) -> Bool {
        guard clips.count > 1,
              let index = clips.firstIndex(where: { $0.id == clipID }) else { return false }
        clips.remove(at: index)
        return true
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

    /// Optional hygiene pass: merges clips that are adjacent **both** in the
    /// sequence and in the source, and share enabled state and label. The
    /// source-contiguity test is what keeps this safe once clips can be
    /// reordered: two segments sitting side by side in the program are only
    /// mergeable if they were also side by side in the recording.
    ///
    /// Never called implicitly — merging discards the ability to recover
    /// individual cuts, so the UI offers it explicitly.
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
    /// Smart-reframe crop paths keyed by participant id, produced by Clip
    /// Studio (SceneAnalyzer → SmartReframer) and consumed by
    /// CompositionBuilder. Absent means every tile center-crops as before.
    var cropPaths: [String: [CropKeyframe]]?
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
         cropPaths: [String: [CropKeyframe]]? = nil,
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
        self.cropPaths = cropPaths
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
