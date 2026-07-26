import SwiftUI
import AVKit

/// The edit-mode shell: track list LEFT, transcript CENTER, preview RIGHT,
/// timeline BOTTOM — transcript and timeline are two views of the same EDL.
struct EditWorkspaceView: View {
    @State private var project: EditProject
    let onClose: () -> Void

    @State private var preview = PreviewPlayer()
    @State private var timelineVM = TimelineViewModel()
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
    @State private var errorMessage: String?


    init(project: EditProject, onClose: @escaping () -> Void) {
        self._project = State(initialValue: project)
        self.onClose = onClose
    }

    var body: some View {
        VSplitView {
            HSplitView {
                trackListPane
                    .frame(minWidth: 180, maxWidth: 260)
                transcriptPane
                    .frame(minWidth: 300)
                previewPane
                    .frame(minWidth: 360)
            }
            .frame(minHeight: 320)

            EditTimelineView(viewModel: timelineVM,
                             project: project,
                             waveforms: waveforms,
                             playheadSource: project.edl.mapTimelineToSource(preview.playheadSeconds),
                             onScrub: { source in
                                 if let timeline = project.edl.mapSourceToTimeline(source) {
                                     preview.seek(to: timeline)
                                 }
                             },
                             onSplitAt: { source in
                                 mutateEDL { _ = $0.splitClip(at: source) }
                             },
                             onToggleClip: { id in
                                 mutateEDL { edl in
                                     if let clip = edl.clips.first(where: { $0.id == id }) {
                                         if clip.enabled {
                                             _ = edl.deleteRange(clip.sourceRange, label: .cutManual)
                                         } else {
                                             _ = edl.recoverClip(id: id)
                                         }
                                     }
                                 }
                             },
                             onDeleteSelection: {},
                             onAddLayoutCue: { time, layout in
                                 project.layoutCues.append(LayoutCue(atTime: time, layout: layout))
                                 project.layoutCues.sort { $0.atTime < $1.atTime }
                                 projectChanged()
                             })
                .frame(minHeight: 150, idealHeight: 210)
        }
        .toolbar { toolbarContent }
        .navigationTitle(project.name)
        .task { await initialLoad() }
        .sheet(isPresented: $showingProposals) { proposalSheet }
        .sheet(isPresented: $showingClips) { clipsSheet }
        .sheet(isPresented: $showingClipStudio) {
            ClipStudioView(project: $project,
                           snapper: snapper,
                           seek: { preview.seek(to: $0) },
                           export: { exportProject, target in
                               exporter.export(project: exportProject, target: target)
                           },
                           onClose: { showingClipStudio = false; projectChanged() })
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
                    HStack {
                        Image(systemName: track.kind == .video ? "video" : "waveform")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading) {
                            Text(track.participantName)
                            Text("\(track.kind.rawValue) · \(Int(track.duration))s")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("Stats") {
                LabeledContent("Source", value: timeString(project.sourceDuration))
                LabeledContent("Edited", value: timeString(project.editedDuration))
                LabeledContent("Cuts", value: "\(project.edl.clips.filter { !$0.enabled }.count)")
            }
        }
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
                                     })
            }
        }
    }

    private var previewPane: some View {
        VStack(spacing: 8) {
            VideoPlayer(player: preview.player)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)

            HStack {
                Button { preview.stepFrame(forward: false) } label: { Image(systemName: "backward.frame") }
                Button { preview.playPause() } label: {
                    Image(systemName: preview.isPlaying ? "pause.fill" : "play.fill")
                }
                .keyboardShortcut(.space, modifiers: [])
                Button { preview.stepFrame(forward: true) } label: { Image(systemName: "forward.frame") }

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

    private func mutateEDL(_ mutate: (inout EditDecisionList) -> Void) {
        mutate(&project.edl)
        projectChanged()
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
