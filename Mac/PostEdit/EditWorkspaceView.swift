import SwiftUI
import AVKit
import AppKit
import UniformTypeIdentifiers

/// The edit-mode shell: tracks, transcript, timeline and preview as four
/// columns. The timeline runs vertically beside the transcript rather than as
/// a strip underneath, so the two can be read against each other — they are
/// two views of the same EDL, and now they line up line by line.
struct EditWorkspaceView: View {
    // Most of this state is internal, not private: the workspace's verbs
    // (async AI actions, undo) live in EditWorkspaceActions.swift — split out
    // for file size — and `private` is file-scoped in Swift.
    @State var project: EditProject
    let onClose: () -> Void

    @State var preview = PreviewPlayer()
    @State var timelineVM = VerticalTimelineViewModel()
    @State private var thumbnails = ThumbnailStore()
    @State var transcriptModel = TranscriptEditModel()
    @State var waveforms = WaveformStore()
    @State var exporter = ExportService()
    @State var snapper: SilenceSnapper?
    @State private var mediaImporter = ExternalMediaImporter()

    @State var isTranscribing = false
    @State var transcribeStatus = ""
    @State var busyMessage: String?
    @State var proposals: [ClaudeTakeSelector.SectionProposal] = []
    @State var showingProposals = false
    @State var clipSuggestions: [ClipSuggestion] = []
    @State var showingClips = false
    @State private var showingClipStudio = false
    @State private var showingPublish = false
    @State private var publishQueue = PublishQueue()
    @State var undoStack: [EditSnapshot] = []
    @State var redoStack: [EditSnapshot] = []
    /// Token of the gesture currently coalescing into one undo step — see
    /// `performEdit(gesture:_:)`.
    @State var activeGesture: String?
    @State var errorMessage: String?


    init(project: EditProject, onClose: @escaping () -> Void) {
        self._project = State(initialValue: project)
        self.onClose = onClose
    }

    var body: some View {
        // The timeline is a column beside the transcript now, not a strip
        // beneath everything — that is the whole point of turning it
        // vertical, so the two can be read against each other.
        HSplitView {
            trackListPane
                .frame(minWidth: 180, maxWidth: 260, maxHeight: .infinity)
            transcriptPane
                .frame(minWidth: 280, maxHeight: .infinity)
            verticalTimeline
                .frame(minWidth: 300, idealWidth: 380, maxHeight: .infinity)
            previewPane
                .frame(minWidth: 340, maxHeight: .infinity)
        }
        // Fill the window. Without the explicit max frame the AppKit-backed
        // HSplitView settled on its children's ideal height and floated as a
        // centered band in a sea of empty window — the editor's first real
        // render found this.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar { toolbarContent }
        .navigationTitle(project.name)
        .task { await initialLoad() }
        .sheet(isPresented: $showingProposals) { proposalSheet }
        .sheet(isPresented: $showingClips) { clipsSheet }
        .sheet(isPresented: $showingClipStudio) {
            ClipStudioView(project: $project,
                           onEdit: { _, mutate in
                               // Named for a future undo-menu label; for now it
                               // just guarantees the sheet's edits are undoable.
                               performEdit { mutate(&project) }
                           },
                           snapper: snapper,
                           seek: { preview.seek(to: $0) },
                           export: { exportProject, target in
                               exporter.export(project: exportProject, target: target)
                           },
                           onClose: { showingClipStudio = false; projectChanged() })
        }
        .sheet(isPresented: $showingPublish) {
            PublishPanelView(queue: publishQueue,
                             initialFileURL: lastExportURL,
                             chaptersText: project.chapters.isEmpty
                                ? nil
                                : ChapterGenerator.youtubeText(project.chapters),
                             onClose: { showingPublish = false })
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
        .overlay {
            if let busyMessage {
                ProgressView(busyMessage)
                    .padding(24)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Panes

    private var trackListPane: some View {
        List {
            if !project.missingMedia.isEmpty {
                Section {
                    missingMediaBanner
                }
            }
            Section("Participants") {
                ForEach(project.tracks.filter { !project.isExternal($0.id) }) { track in
                    trackRow(track)
                }
            }
            Section("Intro / Outro") {
                bookendRow("Intro", clip: project.bookends?.intro) { project.setIntro($0) }
                bookendRow("Outro", clip: project.bookends?.outro) { project.setOutro($0) }
            }
            Section("Music Bed") {
                musicBedRow
            }
            if !project.externalTrackGroups.isEmpty {
                Section("Extra Media") {
                    ForEach(project.externalTrackGroups, id: \.participantID) { group in
                        externalTrackRow(group)
                    }
                }
            }
            Section {
                ForEach(project.binItems) { item in
                    binRow(item)
                }
                Button {
                    importMedia()
                } label: {
                    Label("Add Media…", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .font(.caption)
            } header: {
                Text("Media")
            } footer: {
                // The bin is a shelf, not the mix — first live test read a
                // song sitting here as "music that doesn't play". Name the
                // action.
                Text(project.binItems.isEmpty
                     ? "A shelf for reusable clips: import once, use anywhere."
                     : "The shelf itself doesn't play — use a row's buttons: insert it over the video at the playhead, or add it as an extra camera angle.")
                    .font(.caption2)
            }
            Section("Stats") {
                LabeledContent("Source", value: timeString(project.sourceDuration))
                LabeledContent("Edited", value: timeString(project.editedDuration))
                LabeledContent("Cuts", value: "\(project.edl.clips.filter { !$0.enabled }.count)")
                LabeledContent("Segments", value: "\(project.edl.clips.count)")
            }
        }
    }

    // MARK: - Timeline

    /// Every full-screen-able picture source, in tiling order: participants
    /// first, then synced extra cameras — the multicam angle list.
    private var angles: [(participantId: String, name: String)] {
        project.videoTracks.map { track in
            let name = project.isExternal(track.id)
                ? (project.externalSettings(for: track.id)?.label ?? track.participantName)
                : track.participantName
            return (track.participantId, name)
        }
    }

    /// Multicam cutting: one button per camera, a cut at the playhead. Only
    /// appears once there is something to cut between.
    @ViewBuilder
    private var angleStrip: some View {
        let list = angles
        if list.count > 1 {
            HStack(spacing: 6) {
                Text("Cut to").font(.caption2).foregroundStyle(.secondary)
                ForEach(Array(list.enumerated()), id: \.element.participantId) { index, angle in
                    Button {
                        cutToAngle(angle.participantId)
                    } label: {
                        Text("\(index + 1) · \(angle.name)")
                            .font(.caption2)
                            .lineLimit(1)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .help("Cut to \(angle.name) at the playhead")
                }
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
    }

    /// Drops a full-screen layout cue for this camera at the playhead —
    /// multicam angle cutting. Cues within 50 ms of the playhead are replaced
    /// rather than stacked, so re-cutting a moment doesn't accrete cues.
    private func cutToAngle(_ participantId: String) {
        let sourceTime = project.edl.mapTimelineToSource(preview.playheadSeconds)
        performEdit {
            project.layoutCues.removeAll { abs($0.atTime - sourceTime) < 0.05 }
            project.layoutCues.append(LayoutCue(atTime: sourceTime,
                                                layout: .fullScreen(participantId: participantId)))
            project.layoutCues.sort { $0.atTime < $1.atTime }
        }
    }

    private var verticalTimeline: some View {
        VStack(spacing: 0) {
            angleStrip
            if let intro = project.bookends?.intro {
                bookendCap("Intro", clip: intro, icon: "arrow.right.to.line") {
                    performEdit { project.setIntro(nil) }
                }
                Divider()
            }
            timelineBody
            if let outro = project.bookends?.outro {
                Divider()
                bookendCap("Outro", clip: outro, icon: "arrow.left.to.line") {
                    performEdit { project.setOutro(nil) }
                }
            }
        }
    }

    /// A fixed cap above/below the timeline for the intro/outro. Bookends live
    /// outside edited time — the ruler can't show them — so without these rows
    /// a set intro is invisible the moment the chooser closes ("I see it when I
    /// add it but then… I don't see it as a thing").
    private func bookendCap(_ label: String,
                            clip: BookendClip,
                            icon: String,
                            clear: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(.orange)
            Text("\(label) — \(clip.media.displayName)")
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(timeString(clip.duration))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                preview.playFromProgramStart()
            } label: {
                Image(systemName: "play.circle")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("Play from the very top of the program, \(label.lowercased()) included")
            Button("Clear", action: clear)
                .buttonStyle(.link)
                .font(.caption2)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.orange.opacity(0.08))
    }

    private var timelineBody: some View {
        VerticalTimelineView(
            viewModel: timelineVM,
            project: project,
            waveforms: waveforms,
            thumbnails: thumbnails,
            playhead: preview.playheadSeconds,
            onScrub: { preview.seek(to: $0) },
            onSelectClip: { _ in },
            onMoveClip: { id, index in
                performEdit { _ = project.edl.move(clipID: id, toIndex: index) }
            },
            onTrimClip: { id, range in
                performEdit { _ = project.edl.trim(clipID: id, to: range) }
            },
            onToggleClip: { id in
                mutateEDL { edl in
                    guard let clip = edl.clips.first(where: { $0.id == id }) else { return }
                    if clip.enabled {
                        _ = edl.setEnabled(false, id: id, label: .cutManual)
                    } else {
                        _ = edl.recoverClip(id: id)
                    }
                }
            },
            onMoveOverlay: { id, range in
                // Coalesced: dragging a cutaway fires this continuously, and
                // one ⌘Z should put it back where it started.
                performEdit(gesture: "overlay:" + id.uuidString) {
                    _ = project.setOverlayRange(id: id, to: range)
                }
            },
            onEndDrag: { endGesture() },
            onRemoveOverlay: { id in
                performEdit { project.removeOverlay(id: id) }
            },
            onDropMedia: { url, at in
                Task { await dropCutaway(url: url, at: at) }
            },
            onSplitAtPlayhead: {
                // Timeline-time, so it lands in the occurrence you're looking
                // at even when a moment plays more than once.
                mutateEDL { _ = $0.splitClip(atTimelineTime: preview.playheadSeconds) }
            })
        .onAppear { timelineVM.update(duration: project.editedDuration) }
        .onChange(of: project.editedDuration) { _, new in
            timelineVM.update(duration: new)
        }
    }

    // MARK: - Media bin

    /// Media that no longer resolves. Blocks keep drawing at their timeline
    /// positions so the edit stays legible; only the picture is missing.
    private var missingMediaBanner: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("\(project.missingMedia.count) file(s) missing",
                  systemImage: "questionmark.square.dashed")
                .font(.caption.bold())
                .foregroundStyle(.orange)
            ForEach(project.missingMedia, id: \.path) { reference in
                HStack {
                    Text(reference.displayName).font(.caption2).lineLimit(1)
                    Spacer()
                    Button("Relink…") { relink(reference) }
                        .buttonStyle(.link)
                        .font(.caption2)
                }
            }
        }
    }

    @ViewBuilder
    private func binRow(_ item: MediaBinItem) -> some View {
        HStack(spacing: 6) {
            Image(systemName: item.isStill ? "photo"
                  : item.hasVideo ? "film" : "waveform")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.media.displayName).lineLimit(1)
                HStack(spacing: 4) {
                    if item.duration > 0 {
                        Text(timeString(item.duration))
                    } else {
                        Text("Still")
                    }
                    if item.wasConverted {
                        Text("· Converted")
                    }
                    if item.media.resolve() == nil {
                        Text("· Missing").foregroundStyle(.orange)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer()
            // The two things you DO with a shelf item, as visible buttons —
            // context-menu-only actions read as "extra media that does
            // nothing" (live test said exactly that).
            Button {
                insertCutaway(from: item)
            } label: {
                Image(systemName: item.hasVideo ? "photo.badge.plus" : "music.note.list")
            }
            .buttonStyle(.borderless)
            .help(item.hasVideo ? "Insert as a cutaway at the playhead"
                                : "Insert as a music clip at the playhead")
            Button {
                addExtraTrack(from: item)
            } label: {
                Image(systemName: "video.badge.plus")
            }
            .buttonStyle(.borderless)
            .disabled(!item.hasVideo && !item.hasAudio)
            .help("Add as an extra camera angle (its own lane, cut with the Cut-to strip)")
        }
        .contextMenu {
            Button("Insert as Cutaway at Playhead") { insertCutaway(from: item) }
            Button("Add as Extra Track") { addExtraTrack(from: item) }
                .disabled(!item.hasVideo && !item.hasAudio)
            Button("Reveal in Finder") {
                if let url = item.media.resolve() { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            }
            Button("Remove from Media", role: .destructive) {
                performEdit { project.removeFromBin(id: item.id) }
            }
        }
    }

    private func importMedia() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.externalMediaTypes
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        Task { await ingest(urls: panel.urls) }
    }

    /// One shared list, used by the picker, the bin and drop validation.
    static let externalMediaTypes: [UTType] = [.movie, .mpeg4Movie, .quickTimeMovie, .audio, .image]

    /// Probe, convert if the container needs it, then add to the bin.
    ///
    /// The whole thing is one `performEdit` at the end — pushing a snapshot
    /// before the async work would leave an empty undo step if the probe
    /// failed.
    private func ingest(urls: [URL]) async {
        for url in urls {
            switch await mediaImporter.probe(url) {
            case .ready(let probe):
                addToBin(url: url, probe: probe, converted: false)
            case .protectedContent:
                errorMessage = "\(url.lastPathComponent) is copy-protected and can't be edited."
            case .unreadable(let reason):
                errorMessage = "\(url.lastPathComponent): \(reason)"
            case .needsTranscode(let reason):
                await convert(url: url, reason: reason)
            }
        }
    }

    private func convert(url: URL, reason: String) async {
        busyMessage = "Converting \(url.lastPathComponent)…\n\(reason)"
        defer { busyMessage = nil }
        do {
            let converted = try await mediaImporter.transcode(url, sourceDuration: nil) { _ in }
            switch await mediaImporter.probe(converted) {
            case .ready(let probe):
                addToBin(url: converted, probe: probe, converted: true,
                         displayName: url.deletingPathExtension().lastPathComponent)
            default:
                errorMessage = "\(url.lastPathComponent) converted, but the result couldn't be read."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func addToBin(url: URL, probe: MediaProbe, converted: Bool, displayName: String? = nil) {
        var reference = MediaReference(url: url)
        if let displayName { reference.displayName = displayName }
        performEdit {
            project.addToBin(MediaBinItem(media: reference,
                                          duration: probe.duration,
                                          hasVideo: probe.hasVideo,
                                          hasAudio: probe.hasAudio,
                                          wasConverted: converted))
        }
    }

    private func relink(_ reference: MediaReference) {
        let panel = NSOpenPanel()
        panel.message = "Where is \(reference.displayName)?"
        panel.allowedContentTypes = Self.externalMediaTypes
        panel.directoryURL = URL(fileURLWithPath: reference.path).deletingLastPathComponent()
        guard panel.runModal() == .OK, let url = panel.url else { return }

        var count = 0
        performEdit { count = project.relink(oldPath: reference.path, to: url) }
        if count > 1 {
            errorMessage = "Relinked \(count) files from that folder."
        }
    }

    /// A file dropped straight onto the overlay lane: probe it, add it to the
    /// bin so it can be reused, then place it where it landed.
    ///
    /// One `performEdit` at the end of the async work, not before it — a
    /// snapshot pushed up front would leave an empty undo step if the probe
    /// failed.
    private func dropCutaway(url: URL, at time: Double) async {
        guard case .ready(let probe) = await mediaImporter.probe(url) else {
            await ingest(urls: [url])   // handles conversion, DRM and failure
            return
        }
        let remaining = project.editedDuration - time
        guard remaining > EditDecisionList.minimumClipDuration else {
            errorMessage = "There's no room at the end of the program. Drop it earlier, or use it as an outro."
            return
        }
        let length = probe.duration > 0 ? min(probe.duration, remaining) : min(5, remaining)
        let reference = MediaReference(url: url)
        performEdit {
            project.addToBin(MediaBinItem(media: reference,
                                          duration: probe.duration,
                                          hasVideo: probe.hasVideo,
                                          hasAudio: probe.hasAudio))
            var clip = OverlayClip(media: reference,
                                   timelineRange: time...(time + length))
            if !probe.hasVideo {
                // An audio file on the lane IS a music clip: audible, sitting
                // under the conversation, dipping beneath speech. Place as
                // many as the edit wants; trim and move them like any block.
                clip.audio = ExternalAudio(isEnabled: true,
                                           gainDB: -12,
                                           ducking: nil,
                                           duckUnderSpeechDB: 12)
            }
            project.addOverlay(clip)
        }
        if probe.duration > length {
            errorMessage = String(format: "Trimmed to fit the program (%.1fs of %.1fs used).",
                                  length, probe.duration)
        }
    }

    /// Pick a file and drop it straight on the lane at the playhead — the
    /// keyboard twin of dragging one in.
    private func insertCutawayFromNewFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.externalMediaTypes
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await dropCutaway(url: url, at: preview.playheadSeconds) }
    }

    /// Brings a bin item in as an extra angle, cut alongside the conversation
    /// rather than laid over it.
    private func addExtraTrack(from item: MediaBinItem) {
        performEdit {
            project.addExternalTrack(media: item.media,
                                     label: item.media.displayName,
                                     duration: item.duration,
                                     hasVideo: item.hasVideo,
                                     hasAudio: item.hasAudio)
        }
    }

    /// Puts a bin item on the overlay lane at the playhead, trimmed to fit
    /// whatever room is left.
    private func insertCutaway(from item: MediaBinItem) {
        let start = preview.playheadSeconds
        let remaining = project.editedDuration - start
        guard remaining > EditDecisionList.minimumClipDuration else {
            errorMessage = "There's no room at the end of the program. Drop it earlier."
            return
        }
        let length = item.duration > 0 ? min(item.duration, remaining) : min(5, remaining)
        performEdit {
            var clip = OverlayClip(media: item.media,
                                   timelineRange: start...(start + length))
            if !item.hasVideo {
                // Same music-clip defaults as a direct drop.
                clip.audio = ExternalAudio(isEnabled: true,
                                           gainDB: -12,
                                           ducking: nil,
                                           duckUnderSpeechDB: 12)
            }
            project.addOverlay(clip)
        }
        if item.duration > length {
            errorMessage = String(format: "Trimmed to fit the program (%.1fs of %.1fs used).",
                                  length, item.duration)
        }
    }

    /// Intro or outro. Setting one does not move a single chapter or cutaway —
    /// it only changes where the conversation sits in the exported file.
    @ViewBuilder
    private func bookendRow(_ label: String,
                            clip: BookendClip?,
                            set: @escaping (BookendClip?) -> Void) -> some View {
        HStack(spacing: 6) {
            Image(systemName: label == "Intro" ? "arrow.right.to.line" : "arrow.left.to.line")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.caption)
                Text(clip.map { "\($0.media.displayName) · \(timeString($0.duration))" } ?? "None")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if clip != nil {
                Button("Clear") { performEdit { set(nil) } }
                    .buttonStyle(.link).font(.caption2)
            }
            Button("Choose…") { chooseBookend(set) }
                .buttonStyle(.link).font(.caption2)
        }
    }

    /// Background music under the whole conversation, ducked beneath speech.
    @ViewBuilder
    private var musicBedRow: some View {
        if let bed = project.musicBed {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "music.note").foregroundStyle(.secondary)
                    Text(bed.media.displayName)
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Button("Remove") { performEdit { project.musicBed = nil } }
                        .buttonStyle(.link).font(.caption2)
                }
                HStack(spacing: 6) {
                    Text("Level").font(.caption2).foregroundStyle(.secondary)
                    Slider(value: Binding(
                        get: { project.musicBed?.gainDB ?? -18 },
                        set: { value in performEdit(gesture: "bed-gain") { project.musicBed?.gainDB = value } }
                    ), in: -36...0, onEditingChanged: { if !$0 { endGesture() } })
                    Text(String(format: "%.0f dB", bed.gainDB))
                        .font(.caption2.monospacedDigit())
                        .frame(width: 44, alignment: .trailing)
                }
                Toggle("Duck under speech", isOn: Binding(
                    get: { (project.musicBed?.duckAmountDB ?? 0) > 0 },
                    set: { on in performEdit { project.musicBed?.duckAmountDB = on ? 12 : 0 } }
                ))
                .font(.caption)
                if bed.duckAmountDB > 0, project.transcript == nil {
                    Text("Ducking follows the transcript — transcribe the session to enable it.")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
        } else {
            Button {
                chooseMusicBed()
            } label: {
                Label("Add Music Bed…", systemImage: "music.note")
            }
            .buttonStyle(.borderless)
            .font(.caption)
        }
    }

    private func chooseMusicBed() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        performEdit {
            project.musicBed = MusicBed(media: MediaReference(url: url))
        }
    }

    private func chooseBookend(_ set: @escaping (BookendClip?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.externalMediaTypes
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            let outcome = await mediaImporter.probe(url)
            guard case .ready(let probe) = outcome, probe.duration > 0 else {
                // Say WHY, not just "can't" — the difference between a codec
                // problem and a zero-length file is the whole diagnosis.
                switch outcome {
                case .needsTranscode(let reason), .unreadable(let reason):
                    errorMessage = "\(url.lastPathComponent) can't be an intro/outro: \(reason)"
                case .protectedContent:
                    errorMessage = "\(url.lastPathComponent) is DRM-protected."
                default:
                    errorMessage = "\(url.lastPathComponent) has no playable media."
                }
                return
            }
            // sourceRange is stored rather than probed later: programOffset is
            // read on the main thread every frame, so it must never need to
            // open an asset.
            performEdit {
                set(BookendClip(media: MediaReference(url: url),
                                sourceRange: 0...probe.duration))
            }
            // Park the player at the very top so pressing play shows the new
            // bookend immediately — proof it landed.
            preview.returnToProgramStart()
        }
    }

    /// One imported clip acting as an extra angle.
    ///
    /// Differs from a participant row in what it *is*, not in how you mix it:
    /// the level controls are the same fragment. It shows the file's label,
    /// never the synthesized participant name, which holds a machine id.
    @ViewBuilder
    private func externalTrackRow(_ group: EditProject.ExternalGroup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: group.videoTrack != nil ? "film" : "waveform")
                    .foregroundStyle(.secondary)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "link").font(.system(size: 7))
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.label).lineLimit(1)
                    Text("External · \(timeString(group.duration))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }

            // The one control a participant never needs: import already
            // aligned those.
            HStack(spacing: 4) {
                Text("Offset").font(.caption2).foregroundStyle(.secondary)
                Button("−0.5s") { nudgeExternal(group, by: -0.5) }
                    .buttonStyle(.borderless).font(.caption2)
                Text(String(format: "%+.2fs", group.sourceOffset))
                    .font(.caption2.monospacedDigit())
                Button("+0.5s") { nudgeExternal(group, by: 0.5) }
                    .buttonStyle(.borderless).font(.caption2)
                Spacer()
                // Multicam: line this camera's soundtrack up against the
                // session automatically. Needs the clip to have audio.
                Button("Sync by Audio") { syncExternalByAudio(group) }
                    .buttonStyle(.borderless).font(.caption2)
                    .disabled(group.audioTrack == nil)
                    .help(group.audioTrack == nil
                          ? "This clip has no soundtrack to match"
                          : "Match this clip's soundtrack against the session to set the offset")
            }
            .help("Shifts this clip against the conversation")

            if let audio = group.audioTrack {
                levelControls(for: audio)
            }
        }
        .padding(.vertical, 2)
        .contextMenu {
            Button("Reveal in Finder") {
                if let url = group.videoTrack?.url ?? group.audioTrack?.url {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
            }
            Button("Remove", role: .destructive) {
                performEdit { project.removeExternalTrack(participantID: group.participantID) }
            }
        }
    }

    private func nudgeExternal(_ group: EditProject.ExternalGroup, by delta: Double) {
        performEdit {
            project.setSourceOffset(group.sourceOffset + delta,
                                    forParticipant: group.participantID)
        }
    }

    /// Multicam sync: cross-correlate this clip's soundtrack against the
    /// first participant's audio and set the offset from the match.
    private func syncExternalByAudio(_ group: EditProject.ExternalGroup) {
        guard let externalURL = (group.audioTrack ?? group.videoTrack)?.url else { return }
        // The reference is the session's own sound: the first participant
        // audio track that isn't itself external.
        guard let reference = project.tracks.first(where: {
            $0.kind == .audio && !project.isExternal($0.id)
        }) else {
            errorMessage = "No session audio to sync against."
            return
        }
        busyMessage = "Syncing \(group.label) by audio…"
        Task {
            defer { busyMessage = nil }
            do {
                let alignment = try await AudioAligner.align(externalURL: externalURL,
                                                             referenceURL: reference.url)
                performEdit {
                    project.setSourceOffset(alignment.sourceOffset,
                                            forParticipant: group.participantID)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// One participant row. Audio tracks carry the level controls — the fix
    /// for a guest who recorded hot. Video tracks have nothing to mix.
    @ViewBuilder
    private func trackRow(_ track: EditTrack) -> some View {
        let dimmed = track.kind == .audio
            && project.linearGain(for: track.id) == 0

        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: track.kind == .video ? "video" : "waveform")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(track.participantName)
                        .foregroundStyle(dimmed ? .secondary : .primary)
                    Text("\(track.kind.rawValue) · \(Int(track.duration))s")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if track.kind == .audio {
                levelControls(for: track)
            }
        }
        .padding(.vertical, 2)
    }

    /// Mute / solo / gain for one audio track. Shared verbatim between
    /// participants and imported external media — the two rows differ in what
    /// they are, not in how you mix them.
    @ViewBuilder
    private func levelControls(for track: EditTrack) -> some View {
        let mix = project.mix(for: track.id)
        HStack(spacing: 4) {
            Button("M") { toggleMute(track) }
                .buttonStyle(.borderless)
                .font(.caption2.bold())
                .foregroundStyle(mix.isMuted ? Color.red : .secondary)
                .help("Mute this track")
            Button("S") { toggleSolo(track) }
                .buttonStyle(.borderless)
                .font(.caption2.bold())
                .foregroundStyle(mix.isSolo ? Color.yellow : .secondary)
                .help("Solo — silences everything else")

            Slider(value: Binding(
                get: { project.mix(for: track.id).gainDB },
                set: { newValue in
                    var updated = project.mix(for: track.id)
                    updated.gainDB = newValue
                    // One undo step for the whole drag, not one per tick.
                    performEdit(gesture: "gain:" + track.id) {
                        project.setMix(updated, for: track.id)
                    }
                }
            ), in: -24...12, onEditingChanged: { editing in
                if !editing { endGesture() }
            })
            .controlSize(.mini)

            Text(gainLabel(mix.gainDB))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .trailing)
        }
    }

    private func gainLabel(_ dB: Double) -> String {
        abs(dB) < 0.05 ? "0 dB" : String(format: "%+.1f", dB)
    }

    private func toggleMute(_ track: EditTrack) {
        var updated = project.mix(for: track.id)
        updated.isMuted.toggle()
        setMix(updated, for: track)
    }

    private func toggleSolo(_ track: EditTrack) {
        var updated = project.mix(for: track.id)
        updated.isSolo.toggle()
        setMix(updated, for: track)
    }

    /// Level changes are undoable like any other edit, and rebuild the preview
    /// so you hear the change immediately.
    private func setMix(_ mix: TrackMix, for track: EditTrack) {
        performEdit { project.setMix(mix, for: track.id) }
    }

    private var transcriptPane: some View {
        VStack(spacing: 0) {
            if project.transcript == nil {
                ContentUnavailableView {
                    Label("No transcript yet", systemImage: "text.quote")
                } description: {
                    Text(isTranscribing ? transcribeStatus : "Transcribe to edit the conversation as text.")
                } actions: {
                    Button(isTranscribing ? "Transcribing…" : "Transcribe") {
                        Task { await transcribe() }
                    }
                    .disabled(isTranscribing)
                }
            } else {
                TranscriptEditorView(model: transcriptModel,
                                     playheadSource: project.edl.mapTimelineToSource(preview.playheadSeconds),
                                     isPlaying: preview.isPlaying,
                                     onSeek: { source in
                                         if let timeline = project.edl.mapSourceToTimeline(source) {
                                             preview.seek(to: timeline)
                                         }
                                     },
                                     onDeleteWords: { range in
                                         let snapped = snapRange(range)
                                         mutateEDL { _ = $0.deleteRange(snapped, label: .cutManual) }
                                     },
                                     onRecoverClip: { id in
                                         mutateEDL { _ = $0.recoverClip(id: id) }
                                     },
                                     // Feeds the text-aligned timeline scale:
                                     // without measured geometry it falls back
                                     // to uniform, so this is what makes the
                                     // two panes actually line up.
                                     onWordGeometry: { runs in
                                         timelineVM.update(textRuns: runs)
                                     },
                                     edl: project.edl)
            }
        }
    }

    /// The cutaway the timeline has selected, if any.
    private var selectedOverlay: OverlayClip? {
        guard let id = timelineVM.selectedOverlayID else { return nil }
        return project.overlays?.first { $0.id == id }
    }

    private var previewPane: some View {
        VSplitView {
            preview3Up
            if let overlay = selectedOverlay {
                OverlayInspectorView(
                    overlay: overlay,
                    mediaDuration: project.mediaDuration(forPath: overlay.media.path),
                    onChange: { updated in
                        // Live while dragging, one undo step for the gesture.
                        performEdit(gesture: "overlay-inspector:" + overlay.id.uuidString) {
                            project.updateOverlay(updated)
                        }
                    },
                    onCommit: { endGesture() },
                    onRemove: {
                        performEdit { project.removeOverlay(id: overlay.id) }
                        timelineVM.selectedOverlayID = nil
                    })
                    .frame(minHeight: 160, idealHeight: 240)
            }
        }
    }

    private var preview3Up: some View {
        VStack(spacing: 8) {
            VideoPlayer(player: preview.player)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)

            HStack {
                Button { preview.stepFrame(forward: false) } label: { Image(systemName: "backward.frame") }
                    .keyboardShortcut(.leftArrow, modifiers: [])
                    .help("Step one frame back (←)")
                Button { preview.playPause() } label: {
                    Image(systemName: preview.isPlaying ? "pause.fill" : "play.fill")
                }
                .keyboardShortcut(.space, modifiers: [])
                .help("Play / pause (Space)")
                Button { preview.stepFrame(forward: true) } label: { Image(systemName: "forward.frame") }
                    .keyboardShortcut(.rightArrow, modifiers: [])
                    .help("Step one frame forward (→)")

                // The playhead clock is edited time, which pins at 0:00 while
                // an intro plays — say so instead of looking frozen.
                if case .intro(let remaining) = preview.bookendPhase {
                    Text("Intro · \(timeString(remaining))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.orange)
                } else if preview.bookendPhase == .outro {
                    Text("Outro")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Text(timeString(preview.playheadSeconds) + " / " + timeString(project.editedDuration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)

                Spacer()

                Menu("Layout") {
                    layoutButton("Full Screen", .fullScreen(participantId: nil))
                    layoutButton("Side by Side", .sideBySide)
                    layoutButton("Grid", .grid)
                    layoutButton("Active Speaker", .activeSpeaker)
                    layoutButton("Vertical (9:16)", .verticalStacked)
                    // Works with no enum change: an external track carries a
                    // synthetic participant id, so every layout already
                    // addresses it the same way it addresses a person.
                    if !project.externalVideoTracks.isEmpty {
                        Divider()
                        ForEach(project.externalVideoTracks) { track in
                            layoutButton("Full Screen — \(project.externalSettings(for: track.id)?.label ?? track.participantName)",
                                         .fullScreen(participantId: track.participantId))
                        }
                    }
                }
                .frame(width: 100)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
        }
    }

    private func layoutButton(_ name: String, _ layout: ProgramLayout) -> some View {
        Button(name) {
            let source = project.edl.mapTimelineToSource(preview.playheadSeconds)
            // REPLACE a cue already at this moment instead of stacking a
            // twin: two cues with equal atTime resolve by sort order, which
            // is not stable — on a fresh project (default cue at 0) the new
            // layout literally won a coin flip. Undoable like every edit.
            performEdit {
                project.layoutCues.removeAll { abs($0.atTime - source) < 0.05 }
                project.layoutCues.append(LayoutCue(atTime: source, layout: layout))
                project.layoutCues.sort { $0.atTime < $1.atTime }
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup {
            Menu {
                Button("Add Media…") { importMedia() }
                Button("Insert Cutaway at Playhead") { insertCutawayFromNewFile() }
                    .keyboardShortcut("b", modifiers: [])
                Divider()
                Button("Set Intro…") { chooseBookend { project.setIntro($0) } }
                    .keyboardShortcut("i", modifiers: [.option, .command])
                Button("Set Outro…") { chooseBookend { project.setOutro($0) } }
                    .keyboardShortcut("o", modifiers: [.option, .command])
            } label: {
                Label("Add Media", systemImage: "plus.rectangle.on.folder")
            }
            // Deliberately no global KeyboardShortcuts.Name for any of these:
            // that system exists for show control while another app is
            // frontmost, and nobody imports B-roll with Zoom in front.
            // verify on Mac: bare "b" fires while a TextField has focus — the
            // inspector introduces the editor's first text fields, and this is
            // the same class of conflict already tracked at F-266/F-269.

            Button {
                undo()
            } label: {
                Label("Undo", systemImage: "arrow.uturn.backward")
            }
            .keyboardShortcut("z", modifiers: [.command])
            .disabled(undoStack.isEmpty)
            .help("Undo the last edit (⌘Z)")

            Button {
                redo()
            } label: {
                Label("Redo", systemImage: "arrow.uturn.forward")
            }
            .keyboardShortcut("z", modifiers: [.command, .shift])
            .disabled(redoStack.isEmpty)
            .help("Redo (⇧⌘Z)")

            Menu {
                Button("Remove Filler Words") { Task { await cleanup(fillers: true, silences: false) } }
                Button("Tighten Silences") { Task { await cleanup(fillers: false, silences: true) } }
                Button("Both") { Task { await cleanup(fillers: true, silences: true) } }
                Divider()
                Button("Undo Filler Removal") {
                    mutateEDL { AutoCleanup.recoverAll(label: .cutFiller, edl: &$0) }
                }
                Button("Undo Silence Tightening") {
                    mutateEDL { AutoCleanup.recoverAll(label: .cutSilence, edl: &$0) }
                }
            } label: {
                Label("Clean Up", systemImage: "wand.and.stars")
            }
            .disabled(project.transcript == nil)

            Button {
                Task { await runTakeSelection() }
            } label: {
                Label("AI Edit", systemImage: "sparkles")
            }
            .disabled(project.transcript == nil)

            Button {
                Task { await suggestClips() }
            } label: {
                Label("Suggest Clips", systemImage: "scissors")
            }
            .disabled(project.transcript == nil)

            Button {
                Task { await generateChapters() }
            } label: {
                Label("Chapters", systemImage: "list.number")
            }
            .disabled(project.transcript == nil)

            Button {
                showingClipStudio = true
            } label: {
                Label("Clip Studio", systemImage: "sparkles.rectangle.stack")
            }

            Button {
                showingPublish = true
            } label: {
                Label("Publish", systemImage: "paperplane")
            }

            Menu {
                Button("Audio Master (WAV)") { exporter.export(project: project, target: .audioMaster(aac: false)) }
                Button("Audio Master (AAC)") { exporter.export(project: project, target: .audioMaster(aac: true)) }
                Button("Participant Stems") { exporter.export(project: project, target: .stems) }
                Divider()
                Button("Video 1080p") { exporter.export(project: project, target: .video(width: 1920, height: 1080, burnCaptions: project.captions != nil)) }
                Button("Video 4K") { exporter.export(project: project, target: .video(width: 3840, height: 2160, burnCaptions: project.captions != nil)) }
                Button("Vertical 9:16 + Captions") {
                    if project.captions == nil { project.captions = .karaoke }
                    exporter.export(project: project, target: .video(width: 1080, height: 1920, burnCaptions: true))
                }
            } label: {
                Label("Export", systemImage: "square.and.arrow.up")
            }

            Button("Done") { persist(); onClose() }
        }
    }

    // MARK: - Sheets

    private var proposalSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("AI Take Selection").font(.title3.bold())
            List($proposals) { $proposal in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Toggle(proposal.sectionLabel, isOn: $proposal.accepted)
                            .fontWeight(.semibold)
                        Spacer()
                        Text(proposal.confidence)
                            .font(.caption)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(confidenceColor(proposal.confidence).opacity(0.25), in: Capsule())
                    }
                    Text("Keeps \(timeString(proposal.inTime))–\(timeString(proposal.outTime)); cuts \(proposal.rejectedTakes.count) other take(s)\(proposal.additionalCuts.isEmpty ? "" : " + \(proposal.additionalCuts.count) flub(s)")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(proposal.rationale)
                        .font(.caption)
                }
                .padding(.vertical, 4)
            }
            HStack {
                Spacer()
                Button("Cancel") { showingProposals = false }
                Button("Apply AI Edit") {
                    mutateEDL { ClaudeTakeSelector.apply(proposals, to: &$0) }
                    showingProposals = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(!proposals.contains(where: \.accepted))
            }
        }
        .padding()
        .frame(minWidth: 520, minHeight: 400)
    }

    private var clipsSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Suggested Clips").font(.title3.bold())
            List(clipSuggestions) { clip in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(clip.title).fontWeight(.semibold)
                        Spacer()
                        Text("\(clip.viralityScore)")
                            .font(.caption.bold())
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(scoreColor(clip.viralityScore).opacity(0.3), in: Capsule())
                    }
                    Text("\(timeString(clip.timeRange.lowerBound))–\(timeString(clip.timeRange.upperBound)) · hook: “\(clip.hookText)”")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(clip.reasons.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    HStack {
                        Button("Preview") {
                            if let timeline = project.edl.mapSourceToTimeline(clip.timeRange.lowerBound) {
                                preview.seek(to: timeline)
                                preview.player.play()
                            }
                            showingClips = false
                        }
                        Button("Export Vertical") { exportClip(clip, vertical: true) }
                        Button("Export 16:9") { exportClip(clip, vertical: false) }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }
                .padding(.vertical, 4)
            }
            HStack {
                Spacer()
                Button("Close") { showingClips = false }
            }
        }
        .padding()
        .frame(minWidth: 560, minHeight: 420)
    }

}
