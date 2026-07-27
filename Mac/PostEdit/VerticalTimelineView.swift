import SwiftUI
import AppKit

/// The timeline, running **top to bottom** so it sits beside the transcript
/// and scrolls with it.
///
/// Two things make this different from the horizontal strip it replaces:
///
/// 1. It is drawn in **program order**, not source order. Once segments can be
///    reordered, a source-positioned strip simply cannot render the edit —
///    two copies of one moment would land on top of each other. Disabled
///    segments appear as thin collapsed strips at their sequence position,
///    mirroring the struck-through text in the transcript.
/// 2. Vertical distance is supplied by a `TimelineScale`, so the same view
///    renders strict-time and text-aligned modes without knowing which is in
///    use.
struct VerticalTimelineView: View {
    @Bindable var viewModel: VerticalTimelineViewModel
    let project: EditProject
    let waveforms: WaveformStore
    let thumbnails: ThumbnailStore
    /// Playhead in EDITED-timeline seconds (the timeline's own timebase).
    let playhead: Double

    var onScrub: (Double) -> Void
    var onSelectClip: (UUID?) -> Void
    var onMoveClip: (UUID, Int) -> Void
    var onTrimClip: (UUID, ClosedRange<Double>) -> Void
    var onToggleClip: (UUID) -> Void
    var onMoveOverlay: (UUID, ClosedRange<Double>) -> Void
    var onRemoveOverlay: (UUID) -> Void
    var onSplitAtPlayhead: () -> Void

    // Column geometry. Time is the vertical axis, so "lanes" are columns.
    private let rulerWidth: CGFloat = 46
    private let clipColumnWidth: CGFloat = 116
    private let trackColumnWidth: CGFloat = 54
    private let overlayColumnWidth: CGFloat = 74
    private let captionColumnWidth: CGFloat = 96
    private let columnGap: CGFloat = 6
    /// Height a collapsed (cut) segment occupies regardless of its duration.
    private let cutStripHeight: CGFloat = 10

    var body: some View {
        ScrollViewReader { _ in
            ScrollView(.vertical) {
                canvas
                    .frame(height: max(viewModel.scale.contentHeight, 200))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.black.opacity(0.25))
        }
        .overlay(alignment: .topTrailing) { controls.padding(6) }
    }

    // MARK: - Drawing

    private var canvas: some View {
        Canvas { context, size in
            // Computed once per frame and threaded through: every column needs
            // it, and it walks the whole sequence.
            let layouts = segmentLayouts()
            drawRuler(context: context, size: size)
            drawSegments(context: context, layouts: layouts)
            drawTrackColumns(context: context, layouts: layouts)
            drawOverlays(context: context)
            drawCaptions(context: context)
            drawPlayhead(context: context, size: size)
        }
        .contentShape(Rectangle())
        .gesture(dragGesture)
    }

    /// Time ticks down the left edge. Step chosen from how much height a
    /// second currently gets — in text-aligned mode that varies, so this
    /// samples the scale rather than assuming a constant.
    private func drawRuler(context: GraphicsContext, size: CGSize) {
        let duration = max(project.editedDuration, 1)
        let pointsPerSecond = viewModel.scale.contentHeight / CGFloat(duration)
        let step: Double = pointsPerSecond > 60 ? 1 : pointsPerSecond > 16 ? 5 : 30

        var t = 0.0
        while t <= duration {
            let y = viewModel.scale.offset(forTime: t)
            var line = Path()
            line.move(to: CGPoint(x: rulerWidth - 6, y: y))
            line.addLine(to: CGPoint(x: rulerWidth, y: y))
            context.stroke(line, with: .color(.secondary.opacity(0.5)), lineWidth: 1)
            context.draw(Text(timeLabel(t))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.secondary),
                         at: CGPoint(x: rulerWidth - 9, y: y + 6), anchor: .trailing)
            t += step
        }
    }

    /// The sequence itself: one block per segment, in program order.
    private func drawSegments(context: GraphicsContext, layouts: [SegmentLayout]) {
        let x = rulerWidth + columnGap
        for layout in layouts {
            let rect = CGRect(x: x, y: layout.minY,
                              width: clipColumnWidth, height: max(layout.height, 2))
            let isSelected = layout.clip.id == viewModel.selectedClipID

            if layout.clip.enabled {
                context.fill(Path(roundedRect: rect, cornerRadius: 5),
                             with: .color(.accentColor.opacity(0.28)))
                if let poster = posterImage(for: layout), rect.height > 26 {
                    // "Every box has a preview": the poster fills the top of
                    // the block. Drawn in its own layer because clipping is a
                    // mutating operation on the context.
                    let posterRect = CGRect(x: rect.minX, y: rect.minY,
                                            width: rect.width,
                                            height: min(rect.height, 58))
                    context.drawLayer { layer in
                        layer.clip(to: Path(roundedRect: posterRect, cornerRadius: 5))
                        layer.draw(Image(nsImage: poster), in: posterRect)
                    }
                }
            } else {
                // Collapsed strip: a cut is visible and clickable to recover,
                // but doesn't take space proportional to what it removed.
                context.fill(Path(roundedRect: rect, cornerRadius: 3),
                             with: .color(color(for: layout.clip.label).opacity(0.35)))
            }

            context.stroke(Path(roundedRect: rect, cornerRadius: 5),
                           with: .color(isSelected ? .accentColor : .white.opacity(0.15)),
                           lineWidth: isSelected ? 2 : 0.5)

            if rect.height > 16 {
                context.draw(Text(segmentLabel(layout))
                                .font(.system(size: 9))
                                .foregroundStyle(.white.opacity(0.9)),
                             at: CGPoint(x: rect.minX + 5, y: rect.maxY - 8), anchor: .leading)
            }
        }
    }

    /// One column per audio participant, waveform running downward.
    private func drawTrackColumns(context: GraphicsContext, layouts: [SegmentLayout]) {
        var x = rulerWidth + columnGap + clipColumnWidth + columnGap
        let audioTracks = project.tracks.filter { $0.kind == .audio }

        for track in audioTracks {
            let columnRect = CGRect(x: x, y: 0,
                                    width: trackColumnWidth,
                                    height: viewModel.scale.contentHeight)
            let silenced = project.linearGain(for: track.id) == 0
            context.fill(Path(roundedRect: columnRect, cornerRadius: 4),
                         with: .color(.white.opacity(silenced ? 0.02 : 0.05)))

            if let peaks = waveforms.peaks[track.id], !peaks.isEmpty, !silenced {
                drawWaveform(peaks: peaks, in: columnRect, layouts: layouts, context: context)
            }

            context.draw(Text(track.participantName.prefix(8))
                            .font(.system(size: 8))
                            .foregroundStyle(.secondary),
                         at: CGPoint(x: columnRect.midX, y: 8), anchor: .center)
            x += trackColumnWidth + columnGap
        }
    }

    /// Waveform mirrored about the column's centre line, sampled per segment
    /// so it follows the *program*, not the recording.
    private func drawWaveform(peaks: [Float],
                              in column: CGRect,
                              layouts: [SegmentLayout],
                              context: GraphicsContext) {
        let centreX = column.midX
        let halfWidth = column.width / 2 - 3
        var path = Path()

        for layout in layouts where layout.clip.enabled {
            var y = layout.minY
            while y < layout.maxY {
                let time = viewModel.scale.time(forOffset: y)
                let source = sourceTime(forTimeline: time, in: layout)
                let index = Int(source * WaveformStore.peaksPerSecond)
                guard index >= 0, index < peaks.count else { y += 2; continue }
                let magnitude = CGFloat(min(peaks[index] * 3, 1)) * halfWidth
                path.move(to: CGPoint(x: centreX - magnitude, y: y))
                path.addLine(to: CGPoint(x: centreX + magnitude, y: y))
                y += 2
            }
        }
        context.stroke(path, with: .color(.teal.opacity(0.8)), lineWidth: 1)
    }

    /// B-roll cutaways, positioned in edited time like the rest of this view.
    private func drawOverlays(context: GraphicsContext) {
        let x = overlayColumnX
        for overlay in project.sortedOverlays {
            let top = viewModel.scale.offset(forTime: overlay.timelineRange.lowerBound)
            let bottom = viewModel.scale.offset(forTime: overlay.timelineRange.upperBound)
            let rect = CGRect(x: x, y: top, width: overlayColumnWidth,
                              height: max(bottom - top, 4))
            let isSelected = overlay.id == viewModel.selectedOverlayID
            context.fill(Path(roundedRect: rect, cornerRadius: 5),
                         with: .color(.purple.opacity(0.45)))
            context.stroke(Path(roundedRect: rect, cornerRadius: 5),
                           with: .color(isSelected ? .white : .purple.opacity(0.8)),
                           lineWidth: isSelected ? 2 : 0.5)
            if rect.height > 14 {
                context.draw(Text(overlay.media.displayName)
                                .font(.system(size: 8))
                                .foregroundStyle(.white),
                             at: CGPoint(x: rect.minX + 4, y: rect.minY + 8), anchor: .leading)
            }
        }
    }

    /// Caption lines, so you can see what will be burned in and where.
    private func drawCaptions(context: GraphicsContext) {
        guard project.captions != nil, let transcript = project.transcript else { return }
        let x = captionColumnX
        let words = transcript.enabledWords(edl: project.edl)
        guard !words.isEmpty else { return }

        // Group into caption lines using the same rule the renderer uses, then
        // place each by its edited-timeline span.
        let timed = words.map {
            Word(text: $0.word.text,
                 start: $0.timelineStart,
                 end: $0.timelineStart + $0.word.duration,
                 confidence: $0.word.confidence,
                 trackId: $0.word.trackId,
                 isDisfluency: $0.word.isDisfluency)
        }
        for line in CaptionRenderer.lines(from: timed) {
            let top = viewModel.scale.offset(forTime: line.start)
            let bottom = viewModel.scale.offset(forTime: line.end)
            let rect = CGRect(x: x, y: top, width: captionColumnWidth,
                              height: max(bottom - top, 3))
            context.fill(Path(roundedRect: rect, cornerRadius: 3),
                         with: .color(.orange.opacity(0.25)))
            if rect.height > 12 {
                context.draw(Text(line.text)
                                .font(.system(size: 8))
                                .foregroundStyle(.orange),
                             at: CGPoint(x: rect.minX + 4, y: rect.minY + 7), anchor: .leading)
            }
        }
    }

    private func drawPlayhead(context: GraphicsContext, size: CGSize) {
        let y = viewModel.scale.offset(forTime: playhead)
        var line = Path()
        line.move(to: CGPoint(x: 0, y: y))
        line.addLine(to: CGPoint(x: size.width, y: y))
        context.stroke(line, with: .color(.red), lineWidth: 1.5)
    }

    // MARK: - Layout maths

    /// Where each segment sits vertically, in program order.
    ///
    /// Enabled segments take their scale-derived height; disabled ones take a
    /// fixed strip, which is why this can't be derived from the scale alone.
    private func segmentLayouts() -> [SegmentLayout] {
        var out: [SegmentLayout] = []
        var timelineStart = 0.0
        var y: CGFloat = 0

        for clip in project.edl.clips {
            if clip.enabled {
                let top = viewModel.scale.offset(forTime: timelineStart)
                let bottom = viewModel.scale.offset(forTime: timelineStart + clip.duration)
                out.append(SegmentLayout(clip: clip,
                                         timelineStart: timelineStart,
                                         minY: max(top, y),
                                         maxY: max(bottom, top + 2)))
                timelineStart += clip.duration
                y = max(bottom, y)
            } else {
                out.append(SegmentLayout(clip: clip,
                                         timelineStart: timelineStart,
                                         minY: y,
                                         maxY: y + cutStripHeight))
                y += cutStripHeight
            }
        }
        return out
    }

    private struct SegmentLayout {
        let clip: Clip
        let timelineStart: Double
        let minY: CGFloat
        let maxY: CGFloat
        var height: CGFloat { maxY - minY }
    }

    private func sourceTime(forTimeline time: Double, in layout: SegmentLayout) -> Double {
        layout.clip.sourceRange.lowerBound + (time - layout.timelineStart)
    }

    private func posterImage(for layout: SegmentLayout) -> NSImage? {
        guard let videoTrack = project.tracks.first(where: { $0.kind == .video }) else { return nil }
        return thumbnails.image(for: videoTrack, at: layout.clip.sourceRange.lowerBound)
    }

    private var overlayColumnX: CGFloat {
        let audioCount = CGFloat(project.tracks.filter { $0.kind == .audio }.count)
        return rulerWidth + columnGap + clipColumnWidth + columnGap
            + audioCount * (trackColumnWidth + columnGap)
    }

    private var captionColumnX: CGFloat {
        overlayColumnX + overlayColumnWidth + columnGap
    }

    // MARK: - Interaction

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let time = viewModel.scale.time(forOffset: value.location.y)
                if value.translation.height == 0 {
                    // First touch: select whatever is under the pointer.
                    hitTest(at: value.location)
                }
                onScrub(min(max(time, 0), project.editedDuration))
            }
            .onEnded { value in
                guard let dragged = viewModel.draggingClipID else {
                    viewModel.draggingClipID = nil
                    return
                }
                let dropY = value.location.y
                let index = dropIndex(forY: dropY)
                onMoveClip(dragged, index)
                viewModel.draggingClipID = nil
            }
    }

    private func hitTest(at point: CGPoint) {
        let overlayRange = overlayColumnX...(overlayColumnX + overlayColumnWidth)
        if overlayRange.contains(point.x) {
            let hit = project.sortedOverlays.first {
                let top = viewModel.scale.offset(forTime: $0.timelineRange.lowerBound)
                let bottom = viewModel.scale.offset(forTime: $0.timelineRange.upperBound)
                return point.y >= top && point.y <= bottom
            }
            viewModel.selectedOverlayID = hit?.id
            viewModel.selectedClipID = nil
            onSelectClip(nil)
            return
        }

        let hit = segmentLayouts().first { point.y >= $0.minY && point.y <= $0.maxY }
        viewModel.selectedOverlayID = nil
        viewModel.selectedClipID = hit?.clip.id
        viewModel.draggingClipID = hit?.clip.id
        onSelectClip(hit?.clip.id)
    }

    /// Sequence position a drop at `y` corresponds to.
    private func dropIndex(forY y: CGFloat) -> Int {
        let layouts = segmentLayouts()
        for (index, layout) in layouts.enumerated() where y < layout.minY + layout.height / 2 {
            return index
        }
        return layouts.count
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 6) {
            Picker("", selection: $viewModel.mode) {
                Text("Text").tag(VerticalTimelineViewModel.Mode.textAligned)
                Text("Time").tag(VerticalTimelineViewModel.Mode.uniformTime)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 110)
            .help("Line the timeline up with the transcript, or with the clock")

            if viewModel.mode == .uniformTime {
                HStack(spacing: 4) {
                    Button { viewModel.zoom(by: 0.7) } label: { Image(systemName: "minus.magnifyingglass") }
                    Button { viewModel.zoom(by: 1.4) } label: { Image(systemName: "plus.magnifyingglass") }
                }
                .buttonStyle(.borderless)
            }

            // Split lives here rather than in a context menu: a shortcut on a
            // context-menu button only fires while that menu is open.
            Button {
                onSplitAtPlayhead()
            } label: {
                Label("Split", systemImage: "scissors")
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .keyboardShortcut("s", modifiers: [])
            .help("Split the segment under the playhead (S)")

            if let overlayID = viewModel.selectedOverlayID {
                Button(role: .destructive) {
                    onRemoveOverlay(overlayID)
                    viewModel.selectedOverlayID = nil
                } label: {
                    Label("Remove B-Roll", systemImage: "trash")
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .keyboardShortcut(.delete, modifiers: [])
            } else if let clipID = viewModel.selectedClipID {
                Button { onToggleClip(clipID) } label: {
                    Label("Cut / Restore", systemImage: "delete.left")
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .keyboardShortcut(.delete, modifiers: [])
                .help("Cut the selected segment, or restore it (Delete)")
            }
        }
        .padding(6)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Formatting

    private func segmentLabel(_ layout: SegmentLayout) -> String {
        layout.clip.enabled
            ? timeLabel(layout.clip.duration)
            : layout.clip.label.rawValue
    }

    private func timeLabel(_ seconds: Double) -> String {
        String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }

    private func color(for label: ClipLabel) -> Color {
        switch label {
        case .kept: .clear
        case .cutManual: .gray
        case .cutFiller: .blue
        case .cutSilence: .teal
        case .cutFlub, .cutRetake: .orange
        case .adlib: .green
        }
    }
}

// MARK: - View model

@MainActor
@Observable
final class VerticalTimelineViewModel {
    enum Mode: String, CaseIterable, Hashable {
        /// Aligned to the transcript's own text layout.
        case textAligned
        /// Constant points per second.
        case uniformTime
    }

    /// Switching modes has to rebuild the scale, and the picker binds
    /// straight to this — hence didSet rather than a method a caller must
    /// remember to invoke.
    var mode: Mode = .textAligned {
        didSet { if mode != oldValue { rebuildScale() } }
    }
    var pointsPerSecond: CGFloat = 40
    var selectedClipID: UUID?
    var selectedOverlayID: UUID?
    var draggingClipID: UUID?

    /// Measured text geometry from the transcript, refreshed on relayout.
    var textRuns: [TimelineTextRun] = []
    private(set) var duration: Double = 0

    /// The scale in force. Rebuilt when the mode, zoom, measurements or
    /// duration change — cheap, and keeps the view free of branching.
    private(set) var scale: TimelineScale = UniformTimeScale(duration: 0)

    func update(duration: Double) {
        self.duration = duration
        rebuildScale()
    }

    func update(textRuns: [TimelineTextRun]) {
        self.textRuns = textRuns
        rebuildScale()
    }

    func zoom(by factor: CGFloat) {
        pointsPerSecond = min(400, max(4, pointsPerSecond * factor))
        rebuildScale()
    }

    private func rebuildScale() {
        switch mode {
        case .uniformTime:
            scale = UniformTimeScale(pointsPerSecond: pointsPerSecond, duration: duration)
        case .textAligned:
            scale = TextAlignedScale(runs: textRuns,
                                     duration: duration,
                                     fallbackPointsPerSecond: pointsPerSecond)
        }
    }
}
