import SwiftUI
import AppKit
import Observation
import UniformTypeIdentifiers

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
    /// Fires when a drag finishes, so the workspace can close the coalesced
    /// undo step that `onMoveOverlay` has been folding into.
    var onEndDrag: () -> Void
    var onRemoveOverlay: (UUID) -> Void
    /// A file was dropped on the overlay lane at this edited-timeline second.
    var onDropMedia: (URL, Double) -> Void
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
            // Both computed once per frame and threaded through: every column
            // needs them, and `segmentLayouts` walks the whole sequence.
            let layouts = segmentLayouts()
            let laneLayout = lanes
            drawRuler(context: context, size: size)
            drawSegments(context: context, layouts: layouts)
            drawTrackColumns(context: context, layouts: layouts, lanes: laneLayout)
            drawOverlays(context: context, lanes: laneLayout)
            drawCaptions(context: context, lanes: laneLayout)
            drawPlayhead(context: context, size: size)
            drawDropTarget(context: context, lanes: laneLayout)
        }
        .contentShape(Rectangle())
        .gesture(dragGesture)
        .onDrop(of: [.fileURL], delegate: TimelineDropDelegate(
            isOverlayLane: { x in
                let lanes = self.lanes
                return (lanes.overlayX...(lanes.overlayX + self.overlayColumnWidth)).contains(x)
            },
            isSegmentColumn: { x in
                (self.rulerWidth + self.columnGap)...(self.rulerWidth + self.columnGap + self.clipColumnWidth)
                    ~= x
            },
            time: { y in
                min(max(self.viewModel.scale.time(forOffset: y), 0), self.project.editedDuration)
            },
            setTarget: { viewModel.dropTarget = $0 },
            onDrop: onDropMedia))
    }

    /// Drop feedback is *drawn*, because this lane is a Canvas — a SwiftUI
    /// overlay would have to duplicate all of the lane geometry.
    private func drawDropTarget(context: GraphicsContext, lanes: LaneLayout) {
        guard let target = viewModel.dropTarget else { return }
        let y = viewModel.scale.offset(forTime: target.time)

        switch target.kind {
        case .cutaway:
            let column = CGRect(x: lanes.overlayX, y: 0, width: overlayColumnWidth,
                                height: viewModel.scale.contentHeight)
            context.fill(Path(column), with: .color(.purple.opacity(0.15)))
            var line = Path()
            line.move(to: CGPoint(x: lanes.overlayX, y: y))
            line.addLine(to: CGPoint(x: lanes.overlayX + overlayColumnWidth, y: y))
            context.stroke(line, with: .color(.purple), lineWidth: 2)
        case .refused:
            var line = Path()
            line.move(to: CGPoint(x: rulerWidth, y: y))
            line.addLine(to: CGPoint(x: rulerWidth + clipColumnWidth, y: y))
            context.stroke(line, with: .color(.red.opacity(0.7)),
                           style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
        }

        // Naming the outcome before you let go is the entire reason the lane
        // decides this rather than a modifier key — a modifier can't be hinted.
        let label = switch target.kind {
        case .cutaway: "Cutaway at \(timeLabel(target.time))"
        case .refused: "Drop on the B-roll lane"
        }
        let chip = CGRect(x: lanes.overlayX, y: max(0, y - 26), width: 150, height: 20)
        context.fill(Path(roundedRect: chip, cornerRadius: 4),
                     with: .color(.black.opacity(0.75)))
        context.draw(Text(label).font(.system(size: 9)).foregroundStyle(.white),
                     at: CGPoint(x: chip.minX + 6, y: chip.midY), anchor: .leading)
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
                if rect.height > 26,
                   let videoTrack = project.tracks.first(where: { $0.kind == .video }) {
                    // Premiere-style filmstrip: a frame tile every ~58pt down
                    // the block, each showing the moment it sits beside — not
                    // one poster with a wall of blue under it. Frames arrive
                    // async (the store re-invalidates the canvas), so tall
                    // blocks fill in over a second or two.
                    let tileHeight: CGFloat = 58
                    context.drawLayer { layer in
                        layer.clip(to: Path(roundedRect: rect, cornerRadius: 5))
                        var tileY = rect.minY
                        while tileY < rect.maxY - 4 {
                            let height = min(tileHeight, rect.maxY - tileY)
                            let fraction = layout.height > 0
                                ? Double((tileY - rect.minY) / layout.height) : 0
                            let sourceTime = layout.clip.sourceRange.lowerBound
                                + fraction * layout.clip.duration
                            if let frame = thumbnails.image(for: videoTrack, at: sourceTime) {
                                layer.draw(Image(nsImage: frame),
                                           in: CGRect(x: rect.minX, y: tileY,
                                                      width: rect.width, height: height))
                            }
                            tileY += tileHeight
                        }
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

        // Every join between blocks is an edit point. Without a seam the
        // blocks blur into one strip and the cuts are invisible.
        for (upper, lower) in zip(layouts, layouts.dropFirst())
        where upper.clip.enabled && lower.clip.enabled {
            let y = lower.minY
            var seam = Path()
            seam.move(to: CGPoint(x: x, y: y))
            seam.addLine(to: CGPoint(x: x + clipColumnWidth, y: y))
            context.stroke(seam, with: .color(.black.opacity(0.9)), lineWidth: 2)
            context.draw(Text(Image(systemName: "scissors"))
                            .font(.system(size: 8))
                            .foregroundStyle(.white.opacity(0.9)),
                         at: CGPoint(x: x + clipColumnWidth - 9, y: y), anchor: .center)
        }
    }

    /// One column per audio participant, waveform running downward.
    private func drawTrackColumns(context: GraphicsContext,
                                  layouts: [SegmentLayout],
                                  lanes: LaneLayout) {
        for column in lanes.tracks {
            let track = column.track
            let columnRect = CGRect(x: column.x, y: 0,
                                    width: trackColumnWidth,
                                    height: viewModel.scale.contentHeight)
            let isExternal = project.isExternal(track.id)
            let silenced = track.kind == .audio && project.linearGain(for: track.id) == 0
            // External lanes tinted distinctly, so an imported angle never
            // reads as one of the people in the room.
            context.fill(Path(roundedRect: columnRect, cornerRadius: 4),
                         with: .color(isExternal
                                      ? .indigo.opacity(0.16)
                                      : .white.opacity(silenced ? 0.02 : 0.05)))

            if let peaks = waveforms.peaks[track.id], !peaks.isEmpty, !silenced {
                drawWaveform(peaks: peaks, in: columnRect, layouts: layouts, context: context)
            }

            context.draw(Text((project.externalSettings(for: track.id)?.label
                               ?? track.participantName).prefix(8))
                            .font(.system(size: 8))
                            .foregroundStyle(.secondary),
                         at: CGPoint(x: columnRect.midX, y: 8), anchor: .center)
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
    private func drawOverlays(context: GraphicsContext, lanes: LaneLayout) {
        let x = lanes.overlayX
        for overlay in project.sortedOverlays {
            let top = viewModel.scale.offset(forTime: overlay.timelineRange.lowerBound)
            let bottom = viewModel.scale.offset(forTime: overlay.timelineRange.upperBound)
            let rect = CGRect(x: x, y: top, width: overlayColumnWidth,
                              height: max(bottom - top, 4))
            let isSelected = overlay.id == viewModel.selectedOverlayID
            // Music clips (audio-only) read green with a note; picture
            // cutaways stay purple.
            let isMusic = project.overlayIsAudioOnly(overlay)
            let tint: Color = isMusic ? .green : .purple
            context.fill(Path(roundedRect: rect, cornerRadius: 5),
                         with: .color(tint.opacity(0.45)))
            context.stroke(Path(roundedRect: rect, cornerRadius: 5),
                           with: .color(isSelected ? .white : tint.opacity(0.8)),
                           lineWidth: isSelected ? 2 : 0.5)
            if rect.height > 14 {
                context.draw(Text("\(isMusic ? "♪ " : "")\(overlay.media.displayName)")
                                .font(.system(size: 8))
                                .foregroundStyle(.white),
                             at: CGPoint(x: rect.minX + 4, y: rect.minY + 8), anchor: .leading)
            }
        }
    }

    /// Caption lines, so you can see what will be burned in and where.
    private func drawCaptions(context: GraphicsContext, lanes: LaneLayout) {
        guard project.captions != nil, let transcript = project.transcript else { return }
        let x = lanes.captionX
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

    // MARK: - Lane geometry

    /// One track's column.
    struct LaneColumn {
        var track: EditTrack
        var x: CGFloat
    }

    /// Where every lane sits horizontally.
    ///
    /// This used to be derived in two places — the drawing loop walked its own
    /// `x`, and `overlayColumnX` recomputed the same thing from the audio-track
    /// count. Any disagreement between them slides the overlay and caption
    /// lanes out from under hit-testing: you click a cutaway and select a
    /// segment, with nothing on screen to explain why. One source of truth.
    struct LaneLayout {
        var tracks: [LaneColumn]
        var overlayX: CGFloat
        var captionX: CGFloat
        var totalWidth: CGFloat
    }

    /// Tracks that get their own column. Audio only today; imported external
    /// media joins them.
    private var columnTracks: [EditTrack] {
        // Audio participants, plus every external clip's video track — an
        // extra angle is a lane you want to see, even though it has no
        // waveform. This is the widening the single lane layout existed for.
        project.tracks.filter {
            $0.kind == .audio || (project.isExternal($0.id) && $0.kind == .video)
        }
    }

    private var lanes: LaneLayout {
        var x = rulerWidth + columnGap + clipColumnWidth + columnGap
        var columns: [LaneColumn] = []
        for track in columnTracks {
            columns.append(LaneColumn(track: track, x: x))
            x += trackColumnWidth + columnGap
        }
        let overlayX = x
        let captionX = overlayX + overlayColumnWidth + columnGap
        return LaneLayout(tracks: columns,
                          overlayX: overlayX,
                          captionX: captionX,
                          totalWidth: captionX + captionColumnWidth + columnGap)
    }

    // MARK: - Interaction

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if value.translation.height == 0 {
                    // First touch: latch what was grabbed, select it, and
                    // decide once whether this drag scrubs.
                    viewModel.grabbed = grabZone(at: value.location)
                    hitTest(at: value.location)
                    viewModel.dragScrubs = viewModel.grabbed == nil
                        && isScrubZone(x: value.location.x)
                }

                if let grabbed = viewModel.grabbed {
                    applyEdgeDrag(grabbed, to: viewModel.scale.time(forOffset: value.location.y))
                    return
                }
                // Only scrub when the drag *started* on the ruler or the
                // segment column and grabbed nothing. Without this, dragging a
                // cutaway drags the playhead along with it.
                guard viewModel.dragScrubs else { return }
                let time = viewModel.scale.time(forOffset: value.location.y)
                onScrub(min(max(time, 0), project.editedDuration))
            }
            .onEnded { value in
                defer {
                    viewModel.draggingClipID = nil
                    viewModel.dragScrubs = false
                    viewModel.grabbed = nil
                    onEndDrag()
                }
                // An edge drag has already applied itself; only a body drag
                // reorders.
                if viewModel.grabbed != nil { return }
                guard let dragged = viewModel.draggingClipID else { return }
                onMoveClip(dragged, dropIndex(forY: value.location.y))
            }
    }

    /// Moves whichever edge the drag latched onto.
    ///
    /// Trimming a segment edge is expressed in *source* time, because that is
    /// what `EditDecisionList.trim` takes — and it is what lets an edge be
    /// dragged back out into material an earlier cut had taken.
    private func applyEdgeDrag(_ grabbed: GrabZone, to time: Double) {
        let clamped = min(max(time, 0), project.editedDuration)
        switch grabbed {
        case .overlayBody(let id):
            guard let overlay = project.overlays?.first(where: { $0.id == id }) else { return }
            let length = overlay.duration
            let start = min(max(clamped - length / 2, 0), project.editedDuration - length)
            onMoveOverlay(id, start...(start + length))

        case .overlayTop(let id):
            guard let overlay = project.overlays?.first(where: { $0.id == id }) else { return }
            let upper = overlay.timelineRange.upperBound
            guard clamped < upper - EditDecisionList.minimumClipDuration else { return }
            onMoveOverlay(id, clamped...upper)

        case .overlayBottom(let id):
            guard let overlay = project.overlays?.first(where: { $0.id == id }) else { return }
            let lower = overlay.timelineRange.lowerBound
            guard clamped > lower + EditDecisionList.minimumClipDuration else { return }
            onMoveOverlay(id, lower...clamped)

        case .clipTop(let id), .clipBottom(let id):
            guard let layout = segmentLayouts().first(where: { $0.clip.id == id }) else { return }
            let delta = clamped - viewModel.scale.time(forOffset: layout.minY)
            let range = layout.clip.sourceRange
            if case .clipTop = grabbed {
                let lower = range.lowerBound + delta
                guard lower < range.upperBound - EditDecisionList.minimumClipDuration else { return }
                onTrimClip(id, lower...range.upperBound)
            } else {
                let upper = range.lowerBound + (clamped - viewModel.scale.time(forOffset: layout.minY))
                guard upper > range.lowerBound + EditDecisionList.minimumClipDuration else { return }
                onTrimClip(id, range.lowerBound...upper)
            }
        }
    }

    /// The ruler and the segment column are the "seek here" surface; every
    /// other lane belongs to the thing drawn in it.
    private func isScrubZone(x: CGFloat) -> Bool {
        x < rulerWidth + columnGap + clipColumnWidth
    }

    /// Which part of a block a drag grabbed.
    enum GrabZone: Equatable {
        case overlayBody(UUID)
        case overlayTop(UUID)
        case overlayBottom(UUID)
        case clipTop(UUID)
        case clipBottom(UUID)
    }

    /// Hit width of an edge handle, in points.
    private var handleSlop: CGFloat { 8 }

    /// What is under the pointer, latched once at touch-down. Re-hit-testing
    /// every frame is how a drag ends up grabbing a neighbour once two edges
    /// cross each other.
    private func grabZone(at point: CGPoint) -> GrabZone? {
        let laneLayout = lanes
        if (laneLayout.overlayX...(laneLayout.overlayX + overlayColumnWidth)).contains(point.x) {
            for overlay in project.sortedOverlays {
                let top = viewModel.scale.offset(forTime: overlay.timelineRange.lowerBound)
                let bottom = viewModel.scale.offset(forTime: overlay.timelineRange.upperBound)
                guard point.y >= top - handleSlop, point.y <= bottom + handleSlop else { continue }
                if abs(point.y - top) <= handleSlop { return .overlayTop(overlay.id) }
                if abs(point.y - bottom) <= handleSlop { return .overlayBottom(overlay.id) }
                return .overlayBody(overlay.id)
            }
            return nil
        }

        let clipRange = (rulerWidth + columnGap)...(rulerWidth + columnGap + clipColumnWidth)
        if clipRange.contains(point.x) {
            for layout in segmentLayouts() where layout.clip.enabled {
                guard point.y >= layout.minY - handleSlop,
                      point.y <= layout.maxY + handleSlop else { continue }
                if abs(point.y - layout.minY) <= handleSlop { return .clipTop(layout.clip.id) }
                if abs(point.y - layout.maxY) <= handleSlop { return .clipBottom(layout.clip.id) }
            }
        }
        return nil
    }

    private func hitTest(at point: CGPoint) {
        let laneLayout = lanes
        let overlayRange = laneLayout.overlayX...(laneLayout.overlayX + overlayColumnWidth)
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

    /// Swaps the selected segment with its neighbour (delta ±1) — the
    /// arrow-key reordering. `move` removes first, so index+1 lands the clip
    /// after its former next neighbour.
    private func nudgeSelected(_ clipID: UUID, by delta: Int) {
        guard let index = project.edl.clips.firstIndex(where: { $0.id == clipID }) else { return }
        onMoveClip(clipID, index + delta)
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
                        .keyboardShortcut("-", modifiers: [.command])
                        .help("Zoom out (⌘−)")
                    Button { viewModel.zoom(by: 1.4) } label: { Image(systemName: "plus.magnifyingglass") }
                        .keyboardShortcut("=", modifiers: [.command])
                        .help("Zoom in (⌘+)")
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

                // iMovie-style reordering: select a block, arrow it up or
                // down to swap places with its neighbour. The buttons only
                // exist while a clip is selected, so bare arrows never steal
                // scrolling otherwise.
                HStack(spacing: 4) {
                    Button { nudgeSelected(clipID, by: -1) } label: {
                        Image(systemName: "arrow.up")
                    }
                    .keyboardShortcut(.upArrow, modifiers: [])
                    .help("Move this segment earlier (up arrow)")
                    Button { nudgeSelected(clipID, by: 1) } label: {
                        Image(systemName: "arrow.down")
                    }
                    .keyboardShortcut(.downArrow, modifiers: [])
                    .help("Move this segment later (down arrow)")
                }
                .buttonStyle(.borderless)
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

// MARK: - Drop

/// Where a dragged file would land, and what it would become.
struct TimelineDropTarget: Equatable {
    enum Kind: Equatable {
        case cutaway
        /// Dropping into the sequence would change the program's length and
        /// desynchronise the transcript, so it is refused rather than guessed
        /// at — with the refusal naming the lane that does work.
        case refused
    }
    var kind: Kind
    var time: Double
}

/// A `DropDelegate` rather than the closure form of `.onDrop`, because the
/// outcome depends on where the pointer is and the closure form only reports
/// whether it is inside the view at all.
private struct TimelineDropDelegate: DropDelegate {
    let isOverlayLane: (CGFloat) -> Bool
    let isSegmentColumn: (CGFloat) -> Bool
    let time: (CGFloat) -> Double
    let setTarget: (TimelineDropTarget?) -> Void
    let onDrop: (URL, Double) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        // Only claim drops we can honour, so the cursor tells the truth.
        info.hasItemsConforming(to: [.fileURL])
            && (isOverlayLane(info.location.x) || isSegmentColumn(info.location.x))
    }

    func dropEntered(info: DropInfo) { setTarget(target(for: info)) }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        setTarget(target(for: info))
        return DropProposal(operation: isOverlayLane(info.location.x) ? .copy : .forbidden)
    }
    func dropExited(info: DropInfo) { setTarget(nil) }

    func performDrop(info: DropInfo) -> Bool {
        defer { setTarget(nil) }
        guard isOverlayLane(info.location.x) else { return false }
        let at = time(info.location.y)
        for provider in info.itemProviders(for: [.fileURL]) {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in onDrop(url, at) }
            }
        }
        return true
    }

    private func target(for info: DropInfo) -> TimelineDropTarget {
        TimelineDropTarget(kind: isOverlayLane(info.location.x) ? .cutaway : .refused,
                           time: time(info.location.y))
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
    /// Decided once at the start of a drag: does this gesture move the
    /// playhead, or is it manipulating whatever it grabbed?
    var dragScrubs = false
    /// The edge or block latched at touch-down, so a drag can't switch targets
    /// mid-gesture.
    var grabbed: VerticalTimelineView.GrabZone?
    /// Where a dragged file would land, drawn as feedback.
    var dropTarget: TimelineDropTarget?

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
