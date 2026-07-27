import Foundation

/// One imported file, available to be used more than once.
///
/// The bin earns its place on four counts: the same clip often gets used
/// several times, the probe result has to be cached somewhere, relinking needs
/// one place to fix a moved file from — and `BRollSuggester.suggest` already
/// takes a `mediaLibrary` it has never been given anything but the session's
/// own recordings. The bin is that missing input.
struct MediaBinItem: Identifiable, Codable, Hashable {
    let id: UUID
    var media: MediaReference
    /// Cached so the UI never re-probes to draw a row.
    var duration: Double
    var hasVideo: Bool
    var hasAudio: Bool
    /// True when the file was converted on import, so the row can say so.
    var wasConverted: Bool

    init(id: UUID = UUID(),
         media: MediaReference,
         duration: Double,
         hasVideo: Bool,
         hasAudio: Bool,
         wasConverted: Bool = false) {
        self.id = id
        self.media = media
        self.duration = duration
        self.hasVideo = hasVideo
        self.hasAudio = hasAudio
        self.wasConverted = wasConverted
    }

    var isStill: Bool { duration == 0 && hasVideo }
}

/// Editor-only state for a track that came from a file rather than the
/// session recording.
///
/// A side table keyed by `EditTrack.id`, exactly like `trackMix` — that type's
/// doc comment already argues per-track *editor* state belongs on the project
/// rather than on `EditTrack`, which is shared with the recording models and
/// describes what was recorded. Presence in this dictionary **is** the
/// is-external test.
///
/// `EditTrack.url` is a bare URL with no bookmark, which is the concrete reason
/// the `MediaReference` has to live here: an external file that moves must
/// still be findable.
struct ExternalTrackSettings: Codable, Sendable, Equatable {
    var media: MediaReference
    var label: String
    /// Session-source seconds at which this file's own t=0 sits. The one thing
    /// `EditTrack` genuinely cannot express.
    var sourceOffset: Double
    var audio: ExternalAudio

    init(media: MediaReference,
         label: String,
         sourceOffset: Double = 0,
         audio: ExternalAudio = .silent) {
        self.media = media
        self.label = label
        self.sourceOffset = sourceOffset
        self.audio = audio
    }
}

extension EditProject {
    var binItems: [MediaBinItem] { mediaBin ?? [] }

    /// A project over one imported file, with no podcast session behind it —
    /// for trimming and captioning a clip you were handed.
    ///
    /// The file becomes two tracks, video and audio, sharing a URL. That is
    /// what keeps the waveform store, the thumbnail store, the mixer, the
    /// timeline columns and the composition loop working with no special
    /// cases: they all iterate `tracks`, and this is a project whose tracks
    /// happen to come from one place.
    static func makeStandalone(media: MediaReference,
                               probe: MediaProbe) -> EditProject {
        // A sentinel rather than an optional: `sessionId` is never parsed
        // anywhere outside this type, so no schema change and no migration.
        var project = EditProject(sessionId: "file:\(UUID().uuidString)",
                                  name: media.displayName,
                                  tracks: [],
                                  edl: .initial(sourceDuration: probe.duration))
        let added = project.addExternalTrack(media: media,
                                             label: media.displayName,
                                             duration: probe.duration,
                                             hasVideo: probe.hasVideo,
                                             hasAudio: probe.hasAudio)
        // Its own audio is the point here, unlike an extra angle.
        for trackID in added {
            guard var settings = project.externalSettings(for: trackID) else { continue }
            settings.audio = ExternalAudio(isEnabled: true, gainDB: 0, ducking: nil)
            project.setExternalSettings(settings, for: trackID)
        }
        if let video = project.tracks.first(where: { $0.kind == .video }) {
            project.layoutCues = [LayoutCue(atTime: 0,
                                            layout: .fullScreen(participantId: video.participantId))]
        }
        project.addToBin(MediaBinItem(media: media,
                                      duration: probe.duration,
                                      hasVideo: probe.hasVideo,
                                      hasAudio: probe.hasAudio))
        return project
    }

    /// False for a standalone project, which several AI features need to know.
    var hasSession: Bool { !sessionId.hasPrefix("file:") && !sessionId.isEmpty }

    // MARK: External tracks

    func externalSettings(for trackID: String) -> ExternalTrackSettings? {
        externalMedia?[trackID]
    }

    func isExternal(_ trackID: String) -> Bool { externalMedia?[trackID] != nil }

    var externalVideoTracks: [EditTrack] {
        tracks.filter { $0.kind == .video && isExternal($0.id) }
    }

    /// A synthetic participant id, so layouts, tiling, crop paths and the
    /// compositor all address an external track exactly as they address a
    /// person — with no enum change and no parallel code path.
    static func externalParticipantID(_ id: UUID) -> String { "external-\(id.uuidString)" }

    /// Adds a file as a pair of tracks — one video, one audio, same URL.
    ///
    /// Two tracks rather than one because `EditTrack.kind` is one medium per
    /// file, and splitting is what keeps the waveform store, the mixer, the
    /// timeline columns and the composition loop working untouched.
    @discardableResult
    mutating func addExternalTrack(media: MediaReference,
                                   label: String,
                                   duration: Double,
                                   hasVideo: Bool,
                                   hasAudio: Bool,
                                   sourceOffset: Double = 0) -> [String] {
        guard let url = media.resolve() else { return [] }
        let participant = Self.externalParticipantID(UUID())
        var settings = externalMedia ?? [:]
        var added: [String] = []

        for (kind, present) in [(TrackKind.video, hasVideo), (TrackKind.audio, hasAudio)] {
            guard present else { continue }
            let trackID = "\(participant)-\(kind.rawValue)"
            tracks.append(EditTrack(id: trackID,
                                    participantId: participant,
                                    participantName: label,
                                    kind: kind,
                                    url: url,
                                    duration: duration))
            settings[trackID] = ExternalTrackSettings(
                media: media, label: label, sourceOffset: sourceOffset,
                // An extra angle is usually watched, not heard; its audio is
                // opt-in so adding one can't suddenly double the room tone.
                audio: kind == .audio ? .silent : .silent)
            added.append(trackID)
        }
        externalMedia = settings
        return added
    }

    mutating func removeExternalTrack(participantID: String) {
        tracks.removeAll { $0.participantId == participantID }
        externalMedia = (externalMedia ?? [:]).filter { !$0.key.hasPrefix(participantID) }
        if externalMedia?.isEmpty == true { externalMedia = nil }
    }

    mutating func setExternalSettings(_ settings: ExternalTrackSettings, for trackID: String) {
        var all = externalMedia ?? [:]
        all[trackID] = settings
        externalMedia = all
    }

    /// One imported file, and the one or two tracks it produced.
    struct ExternalGroup {
        var participantID: String
        var label: String
        var sourceOffset: Double
        var videoTrack: EditTrack?
        var audioTrack: EditTrack?
        var duration: Double
    }

    /// External media grouped back into files, since that is the unit the user
    /// thinks in — one clip, not a video track and an audio track.
    var externalTrackGroups: [ExternalGroup] {
        let external = tracks.filter { isExternal($0.id) }
        let byParticipant = Dictionary(grouping: external, by: \.participantId)
        return byParticipant.keys.sorted().map { participant in
            let group = byParticipant[participant] ?? []
            let settings = group.compactMap { externalSettings(for: $0.id) }.first
            return ExternalGroup(
                participantID: participant,
                label: settings?.label ?? group.first?.participantName ?? "Clip",
                sourceOffset: settings?.sourceOffset ?? 0,
                videoTrack: group.first { $0.kind == .video },
                audioTrack: group.first { $0.kind == .audio },
                duration: group.map(\.duration).max() ?? 0)
        }
    }

    /// Nudges every track of one external source together, so its picture and
    /// its sound never drift apart.
    mutating func setSourceOffset(_ seconds: Double, forParticipant participantID: String) {
        var all = externalMedia ?? [:]
        for (trackID, var settings) in all where trackID.hasPrefix(participantID) {
            settings.sourceOffset = seconds
            all[trackID] = settings
        }
        externalMedia = all
    }

    mutating func addToBin(_ item: MediaBinItem) {
        var all = mediaBin ?? []
        // Dedupe by resolved path: many cutaways may share one bin item, which
        // is the point, but the same file shouldn't appear twice.
        if let existing = all.first(where: { $0.media.path == item.media.path }) {
            _ = existing
            return
        }
        all.append(item)
        mediaBin = all
    }

    mutating func removeFromBin(id: UUID) {
        mediaBin = (mediaBin ?? []).filter { $0.id != id }
        if mediaBin?.isEmpty == true { mediaBin = nil }
    }

    func binItem(id: UUID) -> MediaBinItem? {
        mediaBin?.first { $0.id == id }
    }

    /// Natural length of whatever media a cutaway points at, when the bin
    /// knows it. Feeds the inspector's "start inside clip" bound.
    func mediaDuration(forPath path: String) -> Double? {
        mediaBin?.first { $0.media.path == path }?.duration
    }

    /// Every piece of media the project references that can no longer be
    /// resolved — bin items, cutaways, and (later) external tracks.
    var missingMedia: [MediaReference] {
        var found: [MediaReference] = []
        for item in binItems where item.media.resolve() == nil { found.append(item.media) }
        for overlay in overlays ?? [] where overlay.media.resolve() == nil {
            found.append(overlay.media)
        }
        return found
    }

    /// Points every reference that lived in the same old folder at the new
    /// one.
    ///
    /// This is the difference between relinking one file and relinking twenty:
    /// media almost always moves as a folder, so fixing one sibling should fix
    /// the rest without twenty more trips through an open panel.
    @discardableResult
    mutating func relink(oldPath: String, to newURL: URL) -> Int {
        let oldParent = (oldPath as NSString).deletingLastPathComponent
        let newParent = newURL.deletingLastPathComponent()
        var relinked = 0

        func rewrite(_ reference: inout MediaReference) {
            let parent = (reference.path as NSString).deletingLastPathComponent
            guard parent == oldParent else { return }
            let candidate = newParent
                .appendingPathComponent((reference.path as NSString).lastPathComponent)
            guard FileManager.default.fileExists(atPath: candidate.path) else { return }
            reference = MediaReference(url: candidate)
            relinked += 1
        }

        if var bin = mediaBin {
            for index in bin.indices { rewrite(&bin[index].media) }
            mediaBin = bin
        }
        if var all = overlays {
            for index in all.indices { rewrite(&all[index].media) }
            overlays = all
        }
        return relinked
    }
}
