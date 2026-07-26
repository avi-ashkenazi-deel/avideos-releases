import SwiftUI

/// Timeline state: zoom, scroll, selection. Times shown are SOURCE seconds
/// (the common aligned timeline); cut regions are dimmed rather than
/// collapsed so recovery is visual.
@MainActor
@Observable
final class TimelineViewModel {
    var pixelsPerSecond: Double = 40    // zoom, clamped 4…400
    var selectedClipID: UUID?

    func zoom(by factor: Double) {
        pixelsPerSecond = min(400, max(4, pixelsPerSecond * factor))
    }

    func x(for time: Double) -> CGFloat {
        CGFloat(time * pixelsPerSecond)
    }

    func time(for x: CGFloat) -> Double {
        Double(x) / pixelsPerSecond
    }
}

/// Canvas-drawn multitrack timeline: ruler, layout-cue lane, chapters lane,
/// per-track waveform lanes with cut regions dimmed, and a scrubbable
/// playhead. Named EditTimelineView to avoid SwiftUI.TimelineView.
struct EditTimelineView: View {
    @Bindable var viewModel: TimelineViewModel
    let project: EditProject
    let waveforms: WaveformStore
    /// Playhead in SOURCE seconds (the workspace maps from edited time).
    let playheadSource: Double
    var onScrub: (Double) -> Void
    var onSplitAt: (Double) -> Void
    var onToggleClip: (UUID) -> Void
    var onDeleteSelection: () -> Void
    var onAddLayoutCue: (Double, ProgramLayout) -> Void

    private let laneHeight: CGFloat = 44
    private let rulerHeight: CGFloat = 22
    private let cueLaneHeight: CGFloat = 24

    var body: some View {
        ScrollView(.horizontal) {
            canvas
                .frame(width: max(600, viewModel.x(for: project.sourceDuration) + 100))
        }
        .background(Color.black.opacity(0.25))
        .overlay(alignment: .topTrailing) { zoomControls.padding(6) }
    }

    private var totalHeight: CGFloat {
        rulerHeight + cueLaneHeight * 2
            + CGFloat(project.tracks.filter { $0.kind == .audio }.count) * laneHeight
            + laneHeight   // video lane summary
    }

    private var canvas: some View {
        Canvas { context, size in
            drawRuler(context: context, size: size)
            drawCueLanes(context: context)
            drawTracks(context: context)
            drawCutRegions(context: context, height: size.height)
            drawPlayhead(context: context, height: size.height)
        }
        .frame(height: totalHeight)
        .contentShape(Rectangle())
        .gesture(scrubGesture)
        .contextMenu {
            Button("Split at Playhead") { onSplitAt(playheadSource) }
                .keyboardShortcut("s", modifiers: [])
            if let selected = viewModel.selectedClipID {
                Button("Toggle Enabled") { onToggleClip(selected) }
            }
            Menu("Add Layout Cue at Playhead") {
                Button("Grid") { onAddLayoutCue(playheadSource, .grid) }
                Button("Side by Side") { onAddLayoutCue(playheadSource, .sideBySide) }
                Button("Active Speaker") { onAddLayoutCue(playheadSource, .activeSpeaker) }
                Button("Full Screen") { onAddLayoutCue(playheadSource, .fullScreen(participantId: nil)) }
                Button("Vertical Stack (9:16)") { onAddLayoutCue(playheadSource, .verticalStacked) }
            }
        }
    }

    private var zoomControls: some View {
        HStack(spacing: 4) {
            Button { viewModel.zoom(by: 0.7) } label: { Image(systemName: "minus.magnifyingglass") }
            Button { viewModel.zoom(by: 1.4) } label: { Image(systemName: "plus.magnifyingglass") }
        }
        .buttonStyle(.borderless)
        .padding(4)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
    }

    private var scrubGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let time = max(0, min(viewModel.time(for: value.location.x), project.sourceDuration))
                onScrub(time)
                // Click selects the clip under the pointer.
                let midTime = time
                viewModel.selectedClipID = project.edl.clips.first { $0.sourceRange.contains(midTime) }?.id
            }
    }

    // MARK: - Drawing

    private func drawRuler(context: GraphicsContext, size: CGSize) {
        let step: Double = viewModel.pixelsPerSecond > 80 ? 1
            : viewModel.pixelsPerSecond > 20 ? 5
            : 30
        var t: Double = 0
        while t <= project.sourceDuration {
            let x = viewModel.x(for: t)
            context.stroke(Path { $0.move(to: CGPoint(x: x, y: rulerHeight - 6))
                                  $0.addLine(to: CGPoint(x: x, y: rulerHeight)) },
                           with: .color(.secondary), lineWidth: 1)
            let minutes = Int(t) / 60
            let seconds = Int(t) % 60
            context.draw(Text(String(format: "%d:%02d", minutes, seconds))
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.secondary),
                         at: CGPoint(x: x + 3, y: 8), anchor: .leading)
            t += step
        }
    }

    private func drawCueLanes(context: GraphicsContext) {
        // Layout cues.
        let cueY = rulerHeight
        for cue in project.layoutCues {
            let x = viewModel.x(for: cue.atTime)
            let rect = CGRect(x: x, y: cueY + 3, width: 84, height: cueLaneHeight - 6)
            context.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(.blue.opacity(0.5)))
            context.draw(Text(label(for: cue.layout)).font(.system(size: 9)).foregroundStyle(.white),
                         at: CGPoint(x: x + 5, y: cueY + cueLaneHeight / 2), anchor: .leading)
        }
        // Chapters.
        let chapterY = rulerHeight + cueLaneHeight
        for chapter in project.chapters {
            // Chapters live on the EDITED timeline; map back for display.
            let sourceTime = project.edl.mapTimelineToSource(chapter.startTime)
            let x = viewModel.x(for: sourceTime)
            context.stroke(Path { $0.move(to: CGPoint(x: x, y: chapterY))
                                  $0.addLine(to: CGPoint(x: x, y: chapterY + cueLaneHeight)) },
                           with: .color(.orange), lineWidth: 1.5)
            context.draw(Text(chapter.title).font(.system(size: 9)).foregroundStyle(.orange),
                         at: CGPoint(x: x + 4, y: chapterY + cueLaneHeight / 2), anchor: .leading)
        }
    }

    private func drawTracks(context: GraphicsContext) {
        var y = rulerHeight + cueLaneHeight * 2
        for track in project.tracks where track.kind == .audio {
            let laneRect = CGRect(x: 0, y: y, width: viewModel.x(for: track.duration), height: laneHeight - 4)
            context.fill(Path(roundedRect: laneRect, cornerRadius: 4),
                         with: .color(.white.opacity(0.06)))
            if let peaks = waveforms.peaks[track.id], !peaks.isEmpty {
                var path = Path()
                let midY = y + (laneHeight - 4) / 2
                let secondsPerPeak = 1.0 / WaveformStore.peaksPerSecond
                // Draw one bar every few pixels for speed.
                let pixelStride = max(1, Int((2.0 / viewModel.pixelsPerSecond) / secondsPerPeak))
                for i in stride(from: 0, to: peaks.count, by: pixelStride) {
                    let time = Double(i) * secondsPerPeak
                    let x = viewModel.x(for: time)
                    let magnitude = CGFloat(min(peaks[i] * 3, 1)) * (laneHeight - 8) / 2
                    path.move(to: CGPoint(x: x, y: midY - magnitude))
                    path.addLine(to: CGPoint(x: x, y: midY + magnitude))
                }
                context.stroke(path, with: .color(.teal.opacity(0.8)), lineWidth: 1)
            }
            context.draw(Text(track.participantName).font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.secondary),
                         at: CGPoint(x: 6, y: y + 8), anchor: .leading)
            y += laneHeight
        }
        // Video summary lane.
        let videoTracks = project.tracks.filter { $0.kind == .video }
        if !videoTracks.isEmpty {
            let duration = videoTracks.map(\.duration).max() ?? 0
            let rect = CGRect(x: 0, y: y, width: viewModel.x(for: duration), height: laneHeight - 4)
            context.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(.purple.opacity(0.15)))
            context.draw(Text("Video ×\(videoTracks.count)").font(.system(size: 9)).foregroundStyle(.secondary),
                         at: CGPoint(x: 6, y: y + 8), anchor: .leading)
        }
    }

    private func drawCutRegions(context: GraphicsContext, height: CGFloat) {
        for clip in project.edl.clips {
            let startX = viewModel.x(for: clip.sourceRange.lowerBound)
            let endX = viewModel.x(for: clip.sourceRange.upperBound)
            let rect = CGRect(x: startX, y: rulerHeight,
                              width: endX - startX, height: height - rulerHeight)
            if !clip.enabled {
                context.fill(Path(rect), with: .color(color(for: clip.label).opacity(0.22)))
                context.stroke(Path(rect), with: .color(color(for: clip.label).opacity(0.5)), lineWidth: 0.5)
            }
            if clip.id == viewModel.selectedClipID {
                context.stroke(Path(rect), with: .color(.accentColor), lineWidth: 1.5)
            }
        }
    }

    private func drawPlayhead(context: GraphicsContext, height: CGFloat) {
        let x = viewModel.x(for: playheadSource)
        context.stroke(Path { $0.move(to: CGPoint(x: x, y: 0))
                              $0.addLine(to: CGPoint(x: x, y: height)) },
                       with: .color(.red), lineWidth: 1.5)
    }

    private func color(for label: ClipLabel) -> Color {
        switch label {
        case .kept: .clear
        case .cutManual: .gray
        case .cutFlub: .orange
        case .cutRetake: .purple
        case .cutFiller: .yellow
        case .cutSilence: .mint
        case .adlib: .blue
        }
    }

    private func label(for layout: ProgramLayout) -> String {
        switch layout {
        case .fullScreen: "Full"
        case .sideBySide: "Split"
        case .grid: "Grid"
        case .verticalStacked: "9:16"
        case .activeSpeaker: "Speaker"
        }
    }
}
