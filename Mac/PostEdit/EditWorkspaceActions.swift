import SwiftUI
import AppKit
import AVFoundation   // stinger duration probe for bookend defaults

/// EditWorkspaceView's verbs: the async AI actions (transcribe, cleanup, take
/// selection, clips, chapters) and the undo system every edit routes through.
/// Split out of EditWorkspaceView.swift purely for size — that file had
/// crossed a thousand lines; same struct, only the text moved. The state
/// these touch lives in the main file, declared internal for that reason.
extension EditWorkspaceView {

    // MARK: - Actions

    func initialLoad() async {
        if project.edl.clips.isEmpty {
            let duration = project.tracks.map(\.duration).max() ?? 0
            project.edl = .initial(sourceDuration: duration)
            // First-ever open of this project: the brand kit's stingers seed
            // the intro/outro. Only here — a reopened project (clips exist)
            // keeps whatever the user did, including deleting them.
            await applyBrandKitBookendDefaults()
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

        // Auto-transcribe on open: the transcript drives text editing,
        // cleanup, captions, ducking and clips — nobody should have to
        // remember a button. The quick pass lands in seconds; quality
        // improves in place behind it.
        if project.transcript == nil,
           project.tracks.contains(where: { $0.kind == .audio }) {
            Task { await transcribe(auto: true) }
        }
    }

    /// Seeds a brand-new project's bookends from the brand kit's stingers.
    /// The whole file, trimmed later like any bookend; a stinger that can't
    /// be read is skipped silently (the kit editor is where that surfaces).
    private func applyBrandKitBookendDefaults() async {
        guard project.bookends == nil else { return }
        let kit = BrandKitStore().load()
        func bookend(from media: MediaReference?) async -> BookendClip? {
            guard let media, let url = media.resolve() else { return nil }
            let asset = AVURLAsset(url: url)
            guard let duration = try? await asset.load(.duration).seconds, duration > 0 else { return nil }
            return BookendClip(media: media, sourceRange: 0...duration)
        }
        if let intro = await bookend(from: kit.introStinger) { project.setIntro(intro) }
        if let outro = await bookend(from: kit.outroStinger) { project.setOutro(outro) }
    }

    /// Two passes plus a polish: a quick `base`-model pass makes the
    /// transcript usable in seconds, the full-quality model then replaces it
    /// wholesale (safe — cuts live in the EDL as source times, not in the
    /// transcript), and Claude fixes punctuation when a key is stored.
    /// `auto` runs on editor open; its failures go to the status line, not
    /// an alert — nobody asked for anything.
    func transcribe(auto: Bool = false) async {
        guard !isTranscribing else { return }
        isTranscribing = true
        defer { isTranscribing = false }
        do {
            let quick = TranscriptionService(engine: WhisperKitEngine.quick())
            transcribeStatus = "Transcribing (quick pass)…"
            project.transcript = try await quick.transcribe(tracks: project.tracks) { name, fraction in
                Task { @MainActor in
                    transcribeStatus = "Quick pass — \(name)… \(Int(fraction * 100))%"
                }
            }
            projectChanged()

            let best = TranscriptionService()
            var transcript = try await best.transcribe(tracks: project.tracks) { name, fraction in
                Task { @MainActor in
                    transcribeStatus = "Improving quality — \(name)… \(Int(fraction * 100))%"
                }
            }

            if let key = ClaudeAPIClient.storedAPIKey(), !key.isEmpty {
                transcribeStatus = "Polishing punctuation…"
                // Cosmetic pass — a network hiccup must never cost the
                // transcript itself.
                if let polished = try? await PunctuationPolisher().polish(transcript) {
                    transcript = polished.transcript
                }
            }
            project.transcript = transcript
            projectChanged()
            transcribeStatus = ""
        } catch {
            if auto {
                transcribeStatus = "Transcription failed: \(error.localizedDescription)"
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    func cleanup(fillers: Bool, silences: Bool) async {
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

    func runTakeSelection() async {
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

    func suggestClips() async {
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

    func generateChapters() async {
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

    func exportClip(_ clip: ClipSuggestion, vertical: Bool) {
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
        var musicBed: MusicBed?
    }

    var currentSnapshot: EditSnapshot {
        EditSnapshot(edl: project.edl,
                     layoutCues: project.layoutCues,
                     chapters: project.chapters,
                     captions: project.captions,
                     overlays: project.overlays,
                     trackMix: project.trackMix,
                     cropPaths: project.cropPaths,
                     musicBed: project.musicBed)
    }

    /// Every timeline/transcript/cleanup gesture goes through here, so one ⌘Z
    /// reverts one gesture — or one applied AI change-set — atomically.
    ///
    /// `gesture` coalesces a continuous interaction into a single undo step: a
    /// slider drag or an overlay drag fires this on every tick, and without a
    /// token each tick would push its own snapshot — fifty of them would fill
    /// the stack and ⌘Z would move the value a hair. Pass a stable token for
    /// the duration of the gesture and call `endGesture()` when it finishes.
    func performEdit(gesture: String? = nil, _ mutate: () -> Void) {
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
    func endGesture() {
        activeGesture = nil
    }

    func apply(_ snapshot: EditSnapshot) {
        project.edl = snapshot.edl
        project.layoutCues = snapshot.layoutCues
        project.chapters = snapshot.chapters
        project.captions = snapshot.captions
        project.overlays = snapshot.overlays
        project.trackMix = snapshot.trackMix
        project.cropPaths = snapshot.cropPaths
        project.musicBed = snapshot.musicBed
        projectChanged()
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        // Undoing mid-gesture must not fold the next edit into the step we
        // just popped.
        endGesture()
        redoStack.append(currentSnapshot)
        apply(previous)
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        endGesture()
        undoStack.append(currentSnapshot)
        apply(next)
    }

    /// Disables the clip currently selected in the timeline (⌫).
    func deleteTimelineSelection() {
        guard let id = timelineVM.selectedClipID,
              let clip = project.edl.clip(withID: id), clip.enabled else { return }
        performEdit { _ = project.edl.setEnabled(false, id: id, label: .cutManual) }
    }

    func mutateEDL(_ mutate: (inout EditDecisionList) -> Void) {
        performEdit { mutate(&project.edl) }
    }

    /// Most recent finished export, used to seed the publish panel.
    var lastExportURL: URL? {
        exporter.jobs.last { $0.finishedURL != nil }?.finishedURL
    }

    func projectChanged() {
        refreshDerived()
        preview.scheduleRebuild(project: project)
        persist()
    }

    func refreshDerived() {
        transcriptModel.rebuild(transcript: project.transcript,
                                edl: project.edl,
                                playheadSource: project.edl.mapTimelineToSource(preview.playheadSeconds))
    }

    func persist() {
        try? EditProjectStore.write(project)
    }

    func snapRange(_ range: ClosedRange<Double>) -> ClosedRange<Double> {
        guard let snapper else { return range }
        let start = snapper.snap(range.lowerBound)
        let end = snapper.snap(range.upperBound)
        guard end > start else { return range }
        let snapped = start...end
        // Snapping exists to land the cut's EDGES in silence — it must never
        // snap the cut away from the selection. Deleting one short word can
        // pull both edges toward the same pause, leaving a range that misses
        // the word's midpoint entirely — the "deleted" word survives the cut
        // (words map to clips by midpoint).
        let mid = (range.lowerBound + range.upperBound) / 2
        return snapped.contains(mid) ? snapped : range
    }

    func timeString(_ seconds: Double) -> String {
        Timecode.clock(seconds)
    }

    func confidenceColor(_ confidence: String) -> Color {
        switch confidence {
        case "high": .green
        case "medium": .yellow
        default: .orange
        }
    }

    func scoreColor(_ score: Int) -> Color {
        score >= 75 ? .green : score >= 50 ? .yellow : .gray
    }
}
