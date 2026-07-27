import SwiftUI
import AVKit

/// The edit-mode shell: tracks, transcript, timeline and preview as four
/// columns. The timeline runs vertically beside the transcript rather than as
/// a strip underneath, so the two can be read against each other — they are
/// two views of the same EDL, and now they line up line by line.
struct EditWorkspaceView: View {
    @State private var project: EditProject
    let onClose: () -> Void

    @State private var preview = PreviewPlayer()
    @State private var timelineVM = VerticalTimelineViewModel()
    @State private var thumbnails = ThumbnailStore()
    @State private var transcriptModel = TranscriptEditModel()
    @State private var waveforms = WaveformStore()
    @State private var exporter = ExportService()
    @State private var snapper: SilenceSnapper?

    @State private var isTranscribing = false
    @State private var transcribeStatus = ""
    @State private var busyMessage: String?
    @State private var proposals: [ClaudeTakeSelector.SectionProposal] = []
    @State private var showingProposals = false
    @State private var clipSuggestions: [ClipSuggestion] = []
    @State private var showingClips = false
    @State private var showingClipStudio = false
    @State private var showingPublish = false
    @State private var publishQueue = PublishQueue()
    @State private var undoStack: [EditSnapshot] = []
    @State private var redoStack: [EditSnapshot] = []
    /// Token of the gesture currently coalescing into one undo step — see
    /// `performEdit(gesture:_:)`.
    @State private var activeGesture: String?
    @State private var errorMessage: String?


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
                .frame(minWidth: 180, maxWidth: 260)
            transcriptPane
                .frame(minWidth: 280)
            verticalTimeline
                .frame(minWidth: 300, idealWidth: 380)
            previewPane
                .frame(minWidth: 340)
        }
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
            Section("Participants") {
                ForEach(project.tracks) { track in
                    trackRow(track)
                }
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

    private var verticalTimeline: some View {
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
                    mediaDuration: nil,   // filled in once the media bin probes lengths
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
            project.layoutCues.append(LayoutCue(atTime: source, layout: layout))
            project.layoutCues.sort { $0.atTime < $1.atTime }
            projectChanged()
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup {
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

    // MARK: - Actions

    private func initialLoad() async {
        if project.edl.clips.isEmpty {
            let duration = project.tracks.map(\.duration).max() ?? 0
            project.edl = .initial(sourceDuration: duration)
        }
        for track in project.tracks {
            waveforms.ensurePeaks(for: track)
        }
        if let audio = project.tracks.first(where: { $0.kind == .audio }) {
            let s = SilenceSnapper()
            try? await s.analyze(url: audio.url)
            snapper = s
        }
        refreshDerived()
        await preview.rebuild(project: project)
    }

    private func transcribe() async {
        isTranscribing = true
        defer { isTranscribing = false }
        do {
            let service = TranscriptionService()
            project.transcript = try await service.transcribe(tracks: project.tracks) { name, fraction in
                Task { @MainActor in
                    transcribeStatus = "Transcribing \(name)… \(Int(fraction * 100))%"
                }
            }
            projectChanged()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cleanup(fillers: Bool, silences: Bool) async {
        guard let transcript = project.transcript else { return }
        busyMessage = "Cleaning up…"
        defer { busyMessage = nil }
        mutateEDL { edl in
            if fillers {
                _ = AutoCleanup.removeFillers(edl: &edl, transcript: transcript, snapper: snapper)
            }
            if silences, let snapper {
                _ = AutoCleanup.tightenSilences(edl: &edl, snapper: snapper)
            }
        }
    }

    private func runTakeSelection() async {
        guard let transcript = project.transcript else { return }
        // The exact script read during recording; latest saved script as a
        // fallback when the session didn't snapshot one.
        guard let script = ScriptStore().list().first else {
            errorMessage = "No script found — AI take selection compares the recording against a teleprompter script."
            return
        }
        busyMessage = "Detecting takes and asking Claude…"
        defer { busyMessage = nil }
        do {
            let scriptTokens = script.tokens()
            let transcriptTokens = ScriptAligner.transcriptTokens(transcript)
            let spans = ScriptAligner.align(scriptTokens: scriptTokens, transcriptTokens: transcriptTokens)
            let takes = TakeDetector.takes(spans: spans, transcript: transcript,
                                           scriptTokenCount: scriptTokens.count)
            let selector = ClaudeTakeSelector()
            proposals = try await selector.propose(takes: takes, transcript: transcript,
                                                   script: script, snapper: snapper)
            if proposals.isEmpty {
                errorMessage = "No multi-take sections found — nothing to choose between."
            } else {
                showingProposals = true
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func suggestClips() async {
        guard let transcript = project.transcript else { return }
        busyMessage = "Finding clips…"
        defer { busyMessage = nil }
        do {
            clipSuggestions = try await ClipSuggester().suggest(transcript: transcript, snapper: snapper)
            showingClips = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func generateChapters() async {
        guard let transcript = project.transcript else { return }
        busyMessage = "Generating chapters…"
        defer { busyMessage = nil }
        do {
            project.chapters = try await ChapterGenerator().generate(transcript: transcript, edl: project.edl)
            projectChanged()
            let text = ChapterGenerator.youtubeText(project.chapters)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func exportClip(_ clip: ClipSuggestion, vertical: Bool) {
        var sub = project
        sub.name = clip.title
        sub.edl = .initial(sourceDuration: project.sourceDuration)
        // Keep only the clip's range.
        if clip.timeRange.lowerBound > 0 {
            _ = sub.edl.deleteRange(0...clip.timeRange.lowerBound, label: .cutManual)
        }
        if clip.timeRange.upperBound < project.sourceDuration {
            _ = sub.edl.deleteRange(clip.timeRange.upperBound...project.sourceDuration, label: .cutManual)
        }
        if vertical {
            sub.layoutCues = [LayoutCue(atTime: clip.timeRange.lowerBound, layout: .verticalStacked)]
            var style = project.captions ?? .karaoke
            style.emphasisWords = clip.suggestedKeywords
            sub.captions = style
            exporter.export(project: sub, target: .video(width: 1080, height: 1920, burnCaptions: true))
        } else {
            exporter.export(project: sub, target: .video(width: 1920, height: 1080, burnCaptions: sub.captions != nil))
        }
    }

    // MARK: - EDL mutation plumbing

    /// The undoable slice of the project: everything the user *authors*.
    ///
    /// Tracks and the transcript stay out because they are imported or derived
    /// — re-running transcription is not an edit you undo. Overlays, levels and
    /// crop paths are authored, so they belong here; leaving them out meant
    /// ⌘Z restored the EDL and silently left the cutaway moved.
    struct EditSnapshot {
        var edl: EditDecisionList
        var layoutCues: [LayoutCue]
        var chapters: [Chapter]
        var captions: CaptionStyle?
        var overlays: [OverlayClip]?
        var trackMix: [String: TrackMix]?
        var cropPaths: [String: [CropKeyframe]]?
    }

    private var currentSnapshot: EditSnapshot {
        EditSnapshot(edl: project.edl,
                     layoutCues: project.layoutCues,
                     chapters: project.chapters,
                     captions: project.captions,
                     overlays: project.overlays,
                     trackMix: project.trackMix,
                     cropPaths: project.cropPaths)
    }

    /// Every timeline/transcript/cleanup gesture goes through here, so one ⌘Z
    /// reverts one gesture — or one applied AI change-set — atomically.
    ///
    /// `gesture` coalesces a continuous interaction into a single undo step: a
    /// slider drag or an overlay drag fires this on every tick, and without a
    /// token each tick would push its own snapshot — fifty of them would fill
    /// the stack and ⌘Z would move the value a hair. Pass a stable token for
    /// the duration of the gesture and call `endGesture()` when it finishes.
    private func performEdit(gesture: String? = nil, _ mutate: () -> Void) {
        let coalesces = gesture != nil && gesture == activeGesture
        if !coalesces {
            undoStack.append(currentSnapshot)
            if undoStack.count > 50 { undoStack.removeFirst() }
            redoStack.removeAll()
        }
        activeGesture = gesture
        mutate()
        projectChanged()
    }

    /// Closes the current gesture so the next edit starts a fresh undo step.
    /// Call from `onEditingChanged: false` and `DragGesture.onEnded`.
    private func endGesture() {
        activeGesture = nil
    }

    private func apply(_ snapshot: EditSnapshot) {
        project.edl = snapshot.edl
        project.layoutCues = snapshot.layoutCues
        project.chapters = snapshot.chapters
        project.captions = snapshot.captions
        project.overlays = snapshot.overlays
        project.trackMix = snapshot.trackMix
        project.cropPaths = snapshot.cropPaths
        projectChanged()
    }

    private func undo() {
        guard let previous = undoStack.popLast() else { return }
        // Undoing mid-gesture must not fold the next edit into the step we
        // just popped.
        endGesture()
        redoStack.append(currentSnapshot)
        apply(previous)
    }

    private func redo() {
        guard let next = redoStack.popLast() else { return }
        endGesture()
        undoStack.append(currentSnapshot)
        apply(next)
    }

    /// Disables the clip currently selected in the timeline (⌫).
    private func deleteTimelineSelection() {
        guard let id = timelineVM.selectedClipID,
              let clip = project.edl.clip(withID: id), clip.enabled else { return }
        performEdit { _ = project.edl.setEnabled(false, id: id, label: .cutManual) }
    }

    private func mutateEDL(_ mutate: (inout EditDecisionList) -> Void) {
        performEdit { mutate(&project.edl) }
    }

    /// Most recent finished export, used to seed the publish panel.
    private var lastExportURL: URL? {
        exporter.jobs.last { $0.finishedURL != nil }?.finishedURL
    }

    private func projectChanged() {
        refreshDerived()
        preview.scheduleRebuild(project: project)
        persist()
    }

    private func refreshDerived() {
        transcriptModel.rebuild(transcript: project.transcript,
                                edl: project.edl,
                                playheadSource: project.edl.mapTimelineToSource(preview.playheadSeconds))
    }

    private func persist() {
        try? EditProjectStore.write(project)
    }

    private func snapRange(_ range: ClosedRange<Double>) -> ClosedRange<Double> {
        guard let snapper else { return range }
        let start = snapper.snap(range.lowerBound)
        let end = snapper.snap(range.upperBound)
        return end > start ? start...end : range
    }

    private func timeString(_ seconds: Double) -> String {
        let total = Int(max(0, seconds).rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private func confidenceColor(_ confidence: String) -> Color {
        switch confidence {
        case "high": .green
        case "medium": .yellow
        default: .orange
        }
    }

    private func scoreColor(_ score: Int) -> Color {
        score >= 75 ? .green : score >= 50 ? .yellow : .gray
    }
}
