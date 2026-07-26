import SwiftUI
import AppKit
import Observation
import os

/// The AI clip workspace: ranked clip suggestions, natural-language moment
/// search, B-roll suggestions, the caption/brand look, and smart reframe —
/// the engines in this directory all reach the user through here.
///
/// Presented as a sheet from `EditWorkspaceView`; it reads and writes the
/// same `EditProject` binding, so a look chosen here is the look the editor
/// and every export use.
struct ClipStudioView: View {
    @Binding var project: EditProject
    /// Silence snapper for the session's audio, so suggested boundaries land
    /// in silence. Nil until the editor has analyzed a track.
    let snapper: SilenceSnapper?
    /// Seek the workspace preview to an EDITED-timeline second.
    let seek: (Double) -> Void
    /// Hand a derived sub-project to the workspace's ExportService.
    let export: (EditProject, ExportService.Target) -> Void
    let onClose: () -> Void

    @State private var model = ClipStudioModel()
    @State private var templates = CaptionTemplateStore()
    @State private var tab: Tab = .clips
    @State private var options = ClipExportOptions()
    @State private var captionStyle: CaptionStyle = .karaoke

    private enum Tab: String, CaseIterable, Identifiable {
        case clips = "Clips"
        case search = "Search"
        case broll = "B-Roll"
        case look = "Look"
        case reframe = "Reframe"

        var id: String { rawValue }

        var systemImage: String {
            switch self {
            case .clips: return "scissors"
            case .search: return "text.magnifyingglass"
            case .broll: return "film.stack"
            case .look: return "textformat"
            case .reframe: return "crop"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            Divider()
            footer
        }
        .frame(minWidth: 700, minHeight: 520)
        .task {
            captionStyle = project.captions ?? model.brandKit.captionStyle()
        }
        .alert("Clip Studio", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    // MARK: - Chrome

    private var header: some View {
        HStack {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases) { item in
                    Label(item.rawValue, systemImage: item.systemImage).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 460)

            Spacer()

            if let busy = model.busyMessage {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(busy).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
    }

    private var footer: some View {
        HStack {
            if project.transcript == nil {
                Label("Transcribe the session first to enable AI suggestions",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Done") {
                project.captions = captionStyle
                onClose()
            }
            .keyboardShortcut(.defaultAction)
        }
        .padding(10)
    }

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .clips: clipsTab
        case .search: searchTab
        case .broll: brollTab
        case .look: lookTab
        case .reframe: reframeTab
        }
    }

    // MARK: - Clips

    private var clipsTab: some View {
        VSplitView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Suggested Clips").font(.headline)
                    Spacer()
                    Button("Find Clips") {
                        Task { await model.findClips(transcript: project.transcript, snapper: snapper) }
                    }
                    .disabled(project.transcript == nil || model.busyMessage != nil)
                }

                if model.suggestions.isEmpty {
                    placeholder("No clips yet. \"Find Clips\" reads the transcript and ranks 15–90 second candidates.")
                } else {
                    List(model.suggestions) { clip in
                        clipRow(clip)
                    }
                    .listStyle(.inset)
                }
            }
            .padding(10)

            exportOptions
                .padding(10)
        }
    }

    private func clipRow(_ clip: ClipSuggestion) -> some View {
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
            Text("\(timeString(clip.timeRange.lowerBound))–\(timeString(clip.timeRange.upperBound)) · hook: \(clip.hookText)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !clip.reasons.isEmpty {
                Text(clip.reasons.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if !clip.suggestedKeywords.isEmpty {
                Text("Emphasis: " + clip.suggestedKeywords.joined(separator: ", "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            HStack(spacing: 12) {
                Button("Preview") { previewSource(clip.timeRange.lowerBound) }
                Button("Export \(options.aspect.rawValue)") { exportClip(clip) }
                if clip.titleOptions.count > 1 {
                    Menu("Titles") {
                        ForEach(clip.titleOptions.indices, id: \.self) { index in
                            Text(clip.titleOptions[index])
                        }
                    }
                }
            }
            .buttonStyle(.link)
            .font(.caption)
        }
        .padding(.vertical, 4)
    }

    private var exportOptions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Export Settings").font(.headline)
            HStack {
                Text("Aspect").frame(width: 90, alignment: .leading)
                Picker("", selection: $options.aspect) {
                    ForEach(ClipExportOptions.Aspect.allCases) { aspect in
                        Text(aspect.rawValue).tag(aspect)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .onChange(of: options.aspect) { _, new in
                    options.layout = new.defaultLayout
                }
            }
            HStack {
                Text("Layout").frame(width: 90, alignment: .leading)
                Picker("", selection: $options.layout) {
                    ForEach(ClipExportOptions.layoutChoices, id: \.self) { layout in
                        Text(layout.displayName).tag(layout)
                    }
                }
                .labelsHidden()
            }
            Toggle("Burn captions", isOn: $options.burnCaptions)
            Toggle("Smart reframe (keep the speaker in frame)", isOn: $options.useReframe)
                .disabled(model.sceneIndex == nil)
            if model.sceneIndex == nil {
                Text("Run scene analysis in the Reframe tab to enable smart reframe.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Search

    private var searchTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Moment Search").font(.headline)
            HStack {
                TextField("Find every moment we talked about…", text: $model.searchQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { runSearch() }
                Button("Search") { runSearch() }
                    .disabled(project.transcript == nil
                              || model.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
                              || model.busyMessage != nil)
            }
            if model.moments.isEmpty {
                placeholder("Ask in plain language. Search runs over the local transcript, so it is exact and cheap.")
            } else {
                List(model.moments) { moment in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(moment.summary)
                        HStack(spacing: 10) {
                            Text("\(timeString(moment.timeRange.lowerBound))–\(timeString(moment.timeRange.upperBound))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Button("Jump") { previewSource(moment.timeRange.lowerBound) }
                                .buttonStyle(.link)
                                .font(.caption)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.inset)
            }
        }
        .padding(10)
    }

    // MARK: - B-roll

    private var brollTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("B-Roll Suggestions").font(.headline)
                Spacer()
                Button("Suggest B-Roll") {
                    Task { await model.findBRoll(transcript: project.transcript, tracks: project.tracks) }
                }
                .disabled(project.transcript == nil || model.busyMessage != nil)
            }
            Text("Cutaway candidates are matched against this session's own media first. Nothing is inserted automatically.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if model.brollSuggestions.isEmpty {
                placeholder("No suggestions yet.")
            } else {
                List(model.brollSuggestions) { suggestion in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(suggestion.reason)
                        Text("\(timeString(suggestion.timeRange.lowerBound))–\(timeString(suggestion.timeRange.upperBound)) · terms: \(suggestion.searchTerms.joined(separator: ", "))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if suggestion.localCandidates.isEmpty {
                            Text("No local match — search stock or add media to the library.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        } else {
                            ForEach(suggestion.localCandidates, id: \.self) { url in
                                Text(url.lastPathComponent)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Button("Jump") { previewSource(suggestion.timeRange.lowerBound) }
                            .buttonStyle(.link)
                            .font(.caption)
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.inset)
            }
        }
        .padding(10)
    }

    // MARK: - Look (captions + brand)

    private var lookTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                CaptionTemplateGallery(style: $captionStyle, store: templates)

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    Text("Brand Kit").font(.headline)
                    HStack {
                        Text("Font").frame(width: 90, alignment: .leading)
                        TextField("System default", text: $model.brandKit.fontName)
                            .textFieldStyle(.roundedBorder)
                    }
                    HStack {
                        Text("Primary").frame(width: 90, alignment: .leading)
                        TextField("#FFFFFF", text: $model.brandKit.primaryColorHex)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 110)
                        colorChip(model.brandKit.primaryColorHex)
                        Spacer()
                    }
                    HStack {
                        Text("Accent").frame(width: 90, alignment: .leading)
                        TextField("#FFD60A", text: $model.brandKit.accentColorHex)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 110)
                        colorChip(model.brandKit.accentColorHex)
                        Spacer()
                    }
                    HStack {
                        Text("Watermark").frame(width: 90, alignment: .leading)
                        Text(model.brandKit.watermark.media?.displayName ?? "None")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Choose…") { model.chooseWatermark() }
                        if model.brandKit.watermark.media != nil {
                            Button("Clear") { model.brandKit.watermark.media = nil }
                        }
                    }
                    HStack {
                        Text("Opacity").frame(width: 90, alignment: .leading)
                        Slider(value: $model.brandKit.watermark.opacity, in: 0...1)
                        Text(String(format: "%.0f%%", model.brandKit.watermark.opacity * 100))
                            .font(.caption.monospacedDigit())
                            .frame(width: 42, alignment: .trailing)
                    }
                    HStack {
                        Button("Apply Brand Colors to Captions") {
                            captionStyle.fontName = model.brandKit.fontName
                            captionStyle.fillColorHex = model.brandKit.primaryColorHex
                            captionStyle.highlightColorHex = model.brandKit.accentColorHex
                        }
                        Spacer()
                        Button("Save Brand Kit") { model.saveBrandKit() }
                    }
                    Text("The watermark and stingers are stored with the kit; applying them at render time is not wired into the exporter yet.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
        }
    }

    private func colorChip(_ hex: String) -> some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(Color(cgColor: CaptionStyle.color(fromHex: hex)))
            .frame(width: 22, height: 22)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.secondary.opacity(0.4)))
    }

    // MARK: - Reframe

    private var reframeTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Scene Analysis").font(.headline)
                Spacer()
                Button("Analyze Session") {
                    Task { await model.analyzeScenes(tracks: project.tracks) }
                }
                .disabled(model.busyMessage != nil || project.tracks.isEmpty)
            }
            Text("Reads who is speaking when (per-track energy) and tracks each participant's face, then computes an animated crop path so vertical exports keep the speaker in frame.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if model.analyzeProgress > 0 && model.analyzeProgress < 1 {
                ProgressView(value: model.analyzeProgress)
            }

            if let index = model.sceneIndex {
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Speaker segments: \(index.speakerTimeline.count)")
                        ForEach(project.tracks.filter { $0.kind == .video }) { track in
                            let count = index.faceSamples[track.id]?.count ?? 0
                            Text("\(track.participantName): \(count) face samples")
                                .foregroundStyle(count == 0 ? .secondary : .primary)
                        }
                    }
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                HStack {
                    Button("Compute Crop Paths for \(options.aspect.rawValue)") {
                        project.cropPaths = model.cropPaths(for: options.aspect, tracks: project.tracks)
                    }
                    Spacer()
                    if let paths = project.cropPaths, !paths.isEmpty {
                        Text("\(paths.count) path(s) stored with the project")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Clear") { project.cropPaths = nil }
                            .buttonStyle(.link)
                            .font(.caption)
                    }
                }
                Text("Source frames are assumed 16:9; crop paths are recomputed per target aspect.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else {
                placeholder("Not analyzed yet. Analysis runs on the imported masters and is cached with the project.")
            }
        }
        .padding(10)
    }

    // MARK: - Helpers

    private func placeholder(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private func runSearch() {
        Task { await model.search(transcript: project.transcript) }
    }

    /// Seek the workspace preview, mapping a SOURCE time onto the edited
    /// timeline (the preview's own time base). Cut material is skipped to the
    /// nearest surviving frame.
    private func previewSource(_ sourceTime: Double) {
        let enabled = project.edl.nearestEnabledSourceTime(to: sourceTime)
        if let timeline = project.edl.mapSourceToTimeline(enabled) {
            seek(timeline)
        }
    }

    private func exportClip(_ clip: ClipSuggestion) {
        var style = captionStyle
        if style.emphasisWords.isEmpty {
            style.emphasisWords = clip.suggestedKeywords
        }
        let sub = ClipExportOptions.subProject(from: project,
                                              clip: clip,
                                              options: options,
                                              captionStyle: style,
                                              cropPaths: options.useReframe
                                                ? model.cropPaths(for: options.aspect, tracks: project.tracks)
                                                : [:])
        let size = options.aspect.size
        export(sub, .video(width: size.width, height: size.height, burnCaptions: options.burnCaptions))
    }

    private func scoreColor(_ score: Int) -> Color {
        switch score {
        case 80...: return .green
        case 55..<80: return .yellow
        default: return .secondary
        }
    }

    private func timeString(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Export options

/// Target shape for a social export, plus the sub-project derivation that
/// turns one `ClipSuggestion` into something `ExportService` can render.
struct ClipExportOptions {
    enum Aspect: String, CaseIterable, Identifiable, Hashable {
        case vertical = "9:16"
        case square = "1:1"
        case wide = "16:9"

        var id: String { rawValue }

        var size: (width: Int, height: Int) {
            switch self {
            case .vertical: return (1080, 1920)
            case .square: return (1080, 1080)
            case .wide: return (1920, 1080)
            }
        }

        /// width / height, for SmartReframer's crop geometry.
        var ratio: Double {
            let size = self.size
            return Double(size.width) / Double(size.height)
        }

        var defaultLayout: ProgramLayout {
            switch self {
            case .vertical: return .verticalStacked
            case .square: return .activeSpeaker
            case .wide: return .sideBySide
            }
        }
    }

    var aspect: Aspect = .vertical
    var layout: ProgramLayout = .verticalStacked
    var burnCaptions = true
    var useReframe = true

    /// The layouts that make sense for a social clip (grid tiling of a whole
    /// panel is a program layout, not a clip layout).
    static let layoutChoices: [ProgramLayout] = [
        .verticalStacked, .activeSpeaker, .sideBySide, .fullScreen(participantId: nil), .grid,
    ]

    /// One clip as its own project: full-length EDL trimmed to the clip's
    /// source range, a single layout cue at the clip's start (cues are
    /// source-time), the chosen caption style, and any crop paths.
    static func subProject(from project: EditProject,
                           clip: ClipSuggestion,
                           options: ClipExportOptions,
                           captionStyle: CaptionStyle,
                           cropPaths: [String: [CropKeyframe]]) -> EditProject {
        var sub = project
        sub.name = clip.title
        sub.chapters = []
        sub.edl = .initial(sourceDuration: project.sourceDuration)
        if clip.timeRange.lowerBound > 0 {
            _ = sub.edl.deleteRange(0...clip.timeRange.lowerBound, label: .cutManual)
        }
        if clip.timeRange.upperBound < project.sourceDuration {
            _ = sub.edl.deleteRange(clip.timeRange.upperBound...project.sourceDuration, label: .cutManual)
        }
        sub.layoutCues = [LayoutCue(atTime: clip.timeRange.lowerBound, layout: options.layout)]
        sub.captions = options.burnCaptions ? captionStyle : nil
        sub.cropPaths = cropPaths.isEmpty ? nil : cropPaths
        return sub
    }
}

// MARK: - Model

/// Runs the Clip Studio engines and holds their results. Every action is a
/// no-op without a transcript, which is why the view disables its buttons
/// until the session has been transcribed.
@MainActor
@Observable
final class ClipStudioModel {
    var suggestions: [ClipSuggestion] = []
    var moments: [MomentSearch.Moment] = []
    var brollSuggestions: [BRollSuggestion] = []
    var sceneIndex: SceneIndex?
    var brandKit: BrandKit
    var searchQuery = ""
    var busyMessage: String?
    var errorMessage: String?
    var analyzeProgress: Double = 0

    /// Source aspect assumed when computing crop windows. Host and guest
    /// masters are 16:9 by design; a per-track probe is the refinement.
    private let assumedSourceAspect = 16.0 / 9.0

    private let suggester = ClipSuggester()
    private let momentSearch = MomentSearch()
    private let brollSuggester = BRollSuggester()
    private let analyzer = SceneAnalyzer()
    private let brandStore = BrandKitStore()
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "clipstudio")

    init() {
        self.brandKit = BrandKitStore().load()
    }

    func saveBrandKit() {
        brandStore.save(brandKit)
    }

    func chooseWatermark() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        brandKit.watermark.media = MediaReference(url: url)
    }

    func findClips(transcript: Transcript?, snapper: SilenceSnapper?) async {
        guard let transcript else { return }
        await run("Finding clips…") {
            self.suggestions = try await self.suggester.suggest(transcript: transcript, snapper: snapper)
        }
    }

    func search(transcript: Transcript?) async {
        guard let transcript else { return }
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        await run("Searching…") {
            self.moments = try await self.momentSearch.search(query: query, transcript: transcript)
        }
    }

    func findBRoll(transcript: Transcript?, tracks: [EditTrack]) async {
        guard let transcript else { return }
        // The session's own video masters are the first-choice cutaway source.
        let library = tracks.filter { $0.kind == .video }.map(\.url)
        await run("Looking for cutaways…") {
            self.brollSuggestions = try await self.brollSuggester.suggest(transcript: transcript,
                                                                          mediaLibrary: library)
        }
    }

    func analyzeScenes(tracks: [EditTrack]) async {
        analyzeProgress = 0
        await run("Analyzing scenes…") {
            self.sceneIndex = try await self.analyzer.analyze(tracks: tracks) { fraction in
                Task { @MainActor in self.analyzeProgress = fraction }
            }
            self.analyzeProgress = 1
        }
    }

    /// Crop path per participant for a target aspect. Empty when the session
    /// has not been analyzed or no faces were found.
    func cropPaths(for aspect: ClipExportOptions.Aspect,
                   tracks: [EditTrack]) -> [String: [CropKeyframe]] {
        guard let index = sceneIndex else { return [:] }
        var paths: [String: [CropKeyframe]] = [:]
        for track in tracks where track.kind == .video {
            guard let faces = index.faceSamples[track.id], !faces.isEmpty else { continue }
            paths[track.participantId] = SmartReframer.cropPath(
                faces: faces,
                sourceAspect: assumedSourceAspect,
                config: SmartReframer.Config(targetAspect: aspect.ratio))
        }
        return paths
    }

    private func run(_ message: String, _ work: @escaping () async throws -> Void) async {
        busyMessage = message
        defer { busyMessage = nil }
        do {
            try await work()
        } catch {
            log.error("\(message, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
        }
    }
}
