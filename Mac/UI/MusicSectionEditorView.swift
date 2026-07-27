import SwiftUI
import AppKit

/// Where a track gets marked up before a show: a waveform with draggable
/// handles, a table of sections with typed timecodes, and tap-to-mark while it
/// plays.
///
/// A sheet rather than an expanded row in the music panel. The panel caps at
/// 420pt and loses a tab picker and a transport row out of that; a usable
/// waveform plus a ruler plus a section table needs 300pt on its own. Marking
/// up is a before-the-show activity, so modal is right for it — the *live*
/// controls stay in the panel, where they are reachable mid-show.
struct MusicSectionEditorView: View {
    let trackID: UUID
    let onClose: () -> Void

    @Environment(StudioController.self) private var studio
    @State private var waveforms = WaveformStore()
    @State private var pointsPerSecond: CGFloat = 12
    @State private var drag: DragState?

    private var audio: AudioEngineController { studio.audio }
    private var track: MusicTrack? { audio.playlist.first { $0.id == trackID } }
    private var sections: [MusicSection] { track?.sortedSections ?? [] }
    private var isHostTrack: Bool { audio.currentTrackID == trackID }
    /// Only the playing track reports a real duration; otherwise fall back to
    /// the furthest thing authored so the strip still draws something useful.
    private var duration: Double {
        if isHostTrack, audio.musicDuration > 0 { return audio.musicDuration }
        let ends = sections.compactMap { $0.end ?? $0.start }
        return max(ends.max() ?? 0, 60)
    }

    private enum DragState: Equatable {
        case startFlag
        case sectionStart(UUID)
        case sectionEnd(UUID)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            waveformStrip
            Divider()
            sectionTable
            Divider()
            footer
        }
        .frame(minWidth: 760, minHeight: 480)
        .onAppear {
            guard let url = track?.resolve() else { return }
            waveforms.ensurePeaks(url: url,
                                  key: trackID.uuidString,
                                  cacheURL: WaveformStore.cachedPeaksURL(for: url))
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                TextField("Title", text: Binding(
                    get: { track?.title ?? "" },
                    set: { audio.renameTrack(id: trackID, to: $0) }))
                    .textFieldStyle(.plain)
                    .font(.headline)
                if track?.resolve() == nil {
                    Label("File missing", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    Text("\(MusicTimecode.shortString(from: audio.musicPosition)) / \(MusicTimecode.shortString(from: duration))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()

            Button {
                if isHostTrack { audio.musicPlayPause() } else { audio.playTrack(id: trackID) }
            } label: {
                Image(systemName: isHostTrack && audio.isPlayingMusic ? "pause.fill" : "play.fill")
            }
            .help("Author while listening — this drives the real player")

            Button("Drop Marker") { dropMarker() }
                .keyboardShortcut("m", modifiers: [])
                .disabled(!isHostTrack)
                .help("M — drops an open-ended section at the playhead")

            Divider().frame(height: 18)
            Button { zoom(by: 1 / 1.6) } label: { Image(systemName: "minus.magnifyingglass") }
            Button("Fit") { pointsPerSecond = 12 }
            Button { zoom(by: 1.6) } label: { Image(systemName: "plus.magnifyingglass") }
        }
        .padding(10)
    }

    private func zoom(by factor: CGFloat) {
        // Above ~50pt/s the peaks visibly repeat: WaveformStore samples at
        // 50/second and is not re-extracted at higher resolution. Loop points
        // get set by ear and by typed timecode, not by pixel.
        pointsPerSecond = min(50, max(2, pointsPerSecond * factor))
    }

    // MARK: Waveform

    private var contentWidth: CGFloat { max(200, CGFloat(duration) * pointsPerSecond) }

    private var waveformStrip: some View {
        ScrollView(.horizontal) {
            Canvas { context, size in
                drawPeaks(context: context, size: size)
                drawSectionBands(context: context, size: size)
                drawStartFlag(context: context, size: size)
                drawPlayhead(context: context, size: size)
            }
            .frame(width: contentWidth, height: 140)
            .contentShape(Rectangle())
            .gesture(strip)
        }
        .frame(height: 150)
        .background(Color.black.opacity(0.2))
    }

    private func x(for seconds: Double) -> CGFloat { CGFloat(seconds) * pointsPerSecond }
    private func seconds(forX x: CGFloat) -> Double {
        min(max(Double(x / pointsPerSecond), 0), duration)
    }

    private func drawPeaks(context: GraphicsContext, size: CGSize) {
        guard let peaks = waveforms.peaks[trackID.uuidString], !peaks.isEmpty else { return }
        let midY = size.height / 2
        let half = size.height / 2 - 8
        var path = Path()
        var pixel: CGFloat = 0
        while pixel < size.width {
            let index = Int(seconds(forX: pixel) * WaveformStore.peaksPerSecond)
            guard index >= 0, index < peaks.count else { pixel += 1; continue }
            // Same 3x scaling as the editor's timeline, so the two waveform
            // surfaces look like one app.
            let magnitude = CGFloat(min(peaks[index] * 3, 1)) * half
            path.move(to: CGPoint(x: pixel, y: midY - magnitude))
            path.addLine(to: CGPoint(x: pixel, y: midY + magnitude))
            pixel += 1
        }
        context.stroke(path, with: .color(.teal.opacity(0.7)), lineWidth: 1)
    }

    private func drawSectionBands(context: GraphicsContext, size: CGSize) {
        let ranges = MusicSection.resolvedRanges(sections, duration: duration)
        for section in sections {
            guard let range = ranges[section.id] else { continue }
            let rect = CGRect(x: x(for: range.lowerBound), y: 0,
                              width: max(2, x(for: range.upperBound) - x(for: range.lowerBound)),
                              height: size.height)
            let tint = Color(hex: section.colorHex)
            context.fill(Path(rect), with: .color(tint.opacity(0.22)))

            let isPlaying = section.id == audio.playingSectionID
            let isQueued = section.id == audio.queuedSectionID
            context.stroke(Path(rect), with: .color(tint.opacity(isPlaying ? 1 : 0.6)),
                           style: StrokeStyle(lineWidth: isPlaying ? 2 : 1,
                                              dash: isQueued ? [4, 3] : []))
            context.draw(Text(section.name + (isQueued ? " · NEXT" : ""))
                            .font(.system(size: 9, weight: isPlaying ? .bold : .regular))
                            .foregroundStyle(.white),
                         at: CGPoint(x: rect.minX + 4, y: 10), anchor: .leading)
        }
    }

    private func drawStartFlag(context: GraphicsContext, size: CGSize) {
        guard let offset = track?.startOffset, offset > 0 else { return }
        let position = x(for: offset)
        var line = Path()
        line.move(to: CGPoint(x: position, y: 0))
        line.addLine(to: CGPoint(x: position, y: size.height))
        context.stroke(line, with: .color(.green), lineWidth: 2)
        context.draw(Text("START").font(.system(size: 8, weight: .bold)).foregroundStyle(.green),
                     at: CGPoint(x: position + 3, y: size.height - 8), anchor: .leading)
    }

    private func drawPlayhead(context: GraphicsContext, size: CGSize) {
        guard isHostTrack else { return }
        let position = x(for: audio.musicPosition)
        var line = Path()
        line.move(to: CGPoint(x: position, y: 0))
        line.addLine(to: CGPoint(x: position, y: size.height))
        context.stroke(line, with: .color(.white), lineWidth: 1)
    }

    // MARK: Dragging

    /// Hit width for an edge handle, in points.
    private let handleSlop: CGFloat = 6

    private var strip: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                // Latch what was grabbed on first touch. Re-hit-testing every
                // frame is how you end up dragging a neighbour once the edges
                // cross.
                if drag == nil { drag = hitTest(at: value.location.x) }
                apply(drag: drag, to: seconds(forX: value.location.x), commit: false)
            }
            .onEnded { value in
                apply(drag: drag, to: seconds(forX: value.location.x), commit: true)
                drag = nil
            }
    }

    private func hitTest(at pointX: CGFloat) -> DragState? {
        let ranges = MusicSection.resolvedRanges(sections, duration: duration)
        for section in sections {
            guard let range = ranges[section.id] else { continue }
            if abs(pointX - x(for: range.lowerBound)) <= handleSlop { return .sectionStart(section.id) }
            if abs(pointX - x(for: range.upperBound)) <= handleSlop { return .sectionEnd(section.id) }
        }
        if let offset = track?.startOffset, abs(pointX - x(for: offset)) <= handleSlop {
            return .startFlag
        }
        return nil
    }

    /// Live-updates while dragging and writes on release, so the 0.5s settings
    /// debounce doesn't fire sixty times a second.
    private func apply(drag: DragState?, to time: Double, commit: Bool) {
        guard let drag, commit else { return }
        switch drag {
        case .startFlag:
            audio.setStartOffset(time, forTrackID: trackID)
        case .sectionStart(let id):
            guard var section = sections.first(where: { $0.id == id }) else { return }
            section.start = time
            audio.setSection(section, inTrackID: trackID)
        case .sectionEnd(let id):
            guard var section = sections.first(where: { $0.id == id }) else { return }
            // Dragging a right-hand edge is what turns a derived end into an
            // explicit one.
            section.end = time
            audio.setSection(section, inTrackID: trackID)
        }
    }

    private func dropMarker() {
        _ = audio.dropMarkerAtPlayhead()
    }

    // MARK: Table

    private var sectionTable: some View {
        List {
            if sections.isEmpty {
                Text("No sections yet. Play the track and press M to mark one, or use Add Section.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(sections) { section in
                sectionRow(section)
            }
        }
        .listStyle(.inset)
    }

    private func sectionRow(_ section: MusicSection) -> some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(AudioPalette.colors, id: \.self) { hex in
                    Button {
                        var updated = section
                        updated.colorHex = hex
                        audio.setSection(updated, inTrackID: trackID)
                    } label: { Text(hex) }
                }
            } label: {
                Circle().fill(Color(hex: section.colorHex)).frame(width: 12, height: 12)
            }
            .menuStyle(.borderlessButton)
            .frame(width: 22)

            TextField("Name", text: Binding(
                get: { section.name },
                set: { newValue in
                    var updated = section
                    updated.name = newValue
                    audio.setSection(updated, inTrackID: trackID)
                }))
                .textFieldStyle(.roundedBorder)
                .frame(width: 150)

            timecodeField("Start", value: section.start) { newValue in
                var updated = section
                updated.start = newValue
                audio.setSection(updated, inTrackID: trackID)
            }
            timecodeField("End", value: section.end) { newValue in
                var updated = section
                updated.end = newValue
                audio.setSection(updated, inTrackID: trackID)
            }

            Toggle("Loop", isOn: Binding(
                get: { section.loops },
                set: { newValue in
                    var updated = section
                    updated.loops = newValue
                    audio.setSection(updated, inTrackID: trackID)
                }))
                .toggleStyle(.checkbox)

            Picker("Key", selection: Binding(
                get: { section.hotkeyIndex ?? 0 },
                set: { newValue in
                    var updated = section
                    updated.hotkeyIndex = newValue == 0 ? nil : newValue
                    audio.setSection(updated, inTrackID: trackID)
                })) {
                Text("None").tag(0)
                ForEach(1...9, id: \.self) { Text("\($0)").tag($0) }
            }
            .labelsHidden()
            .frame(width: 70)

            Spacer()

            Button {
                audio.setArmedSection(id: track?.armedSectionID == section.id ? nil : section.id,
                                      forTrackID: trackID)
            } label: {
                Image(systemName: track?.armedSectionID == section.id ? "star.fill" : "star")
            }
            .buttonStyle(.borderless)
            .help("Start here when this track loads")

            Button(role: .destructive) {
                audio.removeSection(id: section.id, fromTrackID: trackID)
            } label: { Image(systemName: "trash") }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    /// Typed timecode. Commits on Return and on focus loss; a value that
    /// doesn't parse reverts rather than clearing the field, because a silently
    /// wrong cue is worse than a rejected one.
    private func timecodeField(_ label: String,
                               value: Double?,
                               set: @escaping (Double) -> Void) -> some View {
        TimecodeField(label: label, value: value, onCommit: set)
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            Button("Add Section") {
                let at = isHostTrack ? audio.musicPosition : 0
                _ = audio.addSection(toTrackID: trackID, start: at)
            }
            Button("Prepare Audio") { audio.prepareSections(forTrackID: trackID) }
                .help("Decode every section now, so a live switch never waits")
            Spacer()
            Text("⌥-click a section pad in the music panel to cut regardless of the switch mode.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Done", action: onClose)
                .keyboardShortcut(.defaultAction)
        }
        .padding(10)
    }
}

/// A timecode text field that only writes a value it could parse.
private struct TimecodeField: View {
    let label: String
    let value: Double?
    let onCommit: (Double) -> Void

    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        TextField(label, text: $text)
            .textFieldStyle(.roundedBorder)
            .frame(width: 90)
            .font(.body.monospacedDigit())
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: isFocused) { _, focused in if !focused { commit() } }
            .onAppear { text = display }
            .onChange(of: value) { _, _ in if !isFocused { text = display } }
    }

    private var display: String { value.map(MusicTimecode.string(from:)) ?? "" }

    private func commit() {
        guard let parsed = MusicTimecode.parse(text) else {
            text = display   // revert; never guess at what was meant
            return
        }
        onCommit(parsed)
    }
}
