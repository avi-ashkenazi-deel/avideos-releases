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
    /// nil = fit the whole track to the window, which is what you want the
    /// moment the sheet opens; a number is an explicit zoom.
    @State private var zoomScale: CGFloat?
    @State private var viewportWidth: CGFloat = 760
    @State private var drag: DragState?
    /// The section keyboard actions act on. Click a band to select it.
    @State private var selectedSectionID: UUID?
    @FocusState private var keyboardFocused: Bool

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
        case sectionBody(UUID, grabOffset: Double)
        /// Dragging across empty waveform draws a new section — the way you
        /// actually pick a loop: by eye, across the shape of the music.
        case creating(anchor: Double, current: Double)
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
        .frame(minWidth: 820, minHeight: 520)
        // Keyboard first: marking up a track is a listen-and-tap job, so the
        // sheet takes focus and the transport keys work without aiming at a
        // button. Text fields steal focus while editing, which is correct —
        // space types a space there.
        .focusable()
        .focusEffectDisabled()
        .focused($keyboardFocused)
        .onKeyPress(.space) { togglePlay(); return .handled }
        .onKeyPress(.delete) { deleteSelected(); return .handled }
        .onKeyPress(.deleteForward) { deleteSelected(); return .handled }
        .onKeyPress(.escape) { selectedSectionID = nil; return .handled }
        .onKeyPress(.leftArrow) { nudgeSelected(by: -0.1); return .handled }
        .onKeyPress(.rightArrow) { nudgeSelected(by: 0.1); return .handled }
        .onKeyPress(KeyEquivalent("l")) { toggleLoopOnSelected(); return .handled }
        .onKeyPress(KeyEquivalent("i")) { setSelectedEdgeToPlayhead(start: true); return .handled }
        .onKeyPress(KeyEquivalent("o")) { setSelectedEdgeToPlayhead(start: false); return .handled }
        .onAppear {
            keyboardFocused = true
            guard let url = track?.resolve() else { return }
            waveforms.ensurePeaks(url: url,
                                  key: trackID.uuidString,
                                  cacheURL: WaveformStore.cachedPeaksURL(for: url))
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            // Same top-left close as the other sheets.
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(.red)
            }
            .buttonStyle(.studioIconCompact)
            .help("Close")

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
            .help("Space — author while listening; this drives the real player")

            Button("Mark") { dropMarker() }
                .keyboardShortcut("m", modifiers: [])
                .disabled(!isHostTrack)
                .help("M — drops an open-ended section at the playhead")

            Divider().frame(height: 18)
            Button { zoom(by: 1 / 1.6) } label: { Image(systemName: "minus.magnifyingglass") }
            Button("Fit") { zoomScale = nil }
                .disabled(zoomScale == nil)
            Button { zoom(by: 1.6) } label: { Image(systemName: "plus.magnifyingglass") }
        }
        .padding(10)
    }

    /// Points per second actually in use: the explicit zoom, else whatever
    /// fits the whole track in the window.
    private var pointsPerSecond: CGFloat {
        zoomScale ?? fitScale
    }

    private var fitScale: CGFloat {
        max(1, viewportWidth / max(CGFloat(duration), 1))
    }

    private func zoom(by factor: CGFloat) {
        // Above ~50pt/s the peaks visibly repeat: WaveformStore samples at
        // 50/second and is not re-extracted at higher resolution. Loop points
        // get set by ear and by typed timecode, not by pixel.
        zoomScale = min(50, max(1, pointsPerSecond * factor))
    }

    // MARK: Waveform

    private var contentWidth: CGFloat {
        max(viewportWidth, CGFloat(duration) * pointsPerSecond)
    }

    private var waveformStrip: some View {
        ScrollView(.horizontal) {
            Canvas { context, size in
                drawPeaks(context: context, size: size)
                drawSectionBands(context: context, size: size)
                drawCreationBand(context: context, size: size)
                drawStartFlag(context: context, size: size)
                drawPlayhead(context: context, size: size)
            }
            .frame(width: contentWidth, height: 140)
            .contentShape(Rectangle())
            .gesture(strip)
        }
        .frame(height: 150)
        .background(
            GeometryReader { geo in
                Color.black.opacity(0.2)
                    .onAppear { viewportWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, width in viewportWidth = width }
            }
        )
    }

    /// The band being dragged out right now, before it exists as a section.
    private func drawCreationBand(context: GraphicsContext, size: CGSize) {
        guard case .creating(let anchor, let current) = drag else { return }
        let lower = min(anchor, current), upper = max(anchor, current)
        let rect = CGRect(x: x(for: lower), y: 0,
                          width: max(1, x(for: upper) - x(for: lower)),
                          height: size.height)
        context.fill(Path(rect), with: .color(.white.opacity(0.18)))
        context.stroke(Path(rect), with: .color(.white.opacity(0.8)), lineWidth: 1)
        context.draw(Text(MusicTimecode.shortString(from: upper - lower))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white),
                     at: CGPoint(x: rect.midX, y: size.height / 2))
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
            let isSelected = section.id == selectedSectionID
            context.stroke(Path(rect), with: .color(tint.opacity(isPlaying ? 1 : 0.6)),
                           style: StrokeStyle(lineWidth: isPlaying ? 2 : 1,
                                              dash: isQueued ? [4, 3] : []))
            if isSelected {
                // Keyboard actions target this one; say so.
                context.stroke(Path(rect.insetBy(dx: 1.5, dy: 1.5)),
                               with: .color(.white.opacity(0.9)), lineWidth: 1.5)
            }
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
                let time = seconds(forX: value.location.x)
                // Latch what was grabbed on first touch. Re-hit-testing every
                // frame is how you end up dragging a neighbour once the edges
                // cross.
                if drag == nil {
                    drag = hitTest(at: value.location.x) ?? .creating(anchor: time, current: time)
                    if case .sectionBody(let id, _) = drag { selectedSectionID = id }
                    if case .sectionStart(let id) = drag { selectedSectionID = id }
                    if case .sectionEnd(let id) = drag { selectedSectionID = id }
                }
                // The new-section band needs to redraw as it grows; the others
                // commit on release so the settings debounce isn't hammered.
                if case .creating(let anchor, _) = drag {
                    drag = .creating(anchor: anchor, current: time)
                }
            }
            .onEnded { value in
                apply(drag: drag, to: seconds(forX: value.location.x), commit: true)
                drag = nil
            }
    }

    private func hitTest(at pointX: CGFloat) -> DragState? {
        let ranges = MusicSection.resolvedRanges(sections, duration: duration)
        // Edges first: they sit inside a body, and grabbing an edge is the
        // more precise intent.
        for section in sections {
            guard let range = ranges[section.id] else { continue }
            if abs(pointX - x(for: range.lowerBound)) <= handleSlop { return .sectionStart(section.id) }
            if abs(pointX - x(for: range.upperBound)) <= handleSlop { return .sectionEnd(section.id) }
        }
        if let offset = track?.startOffset, abs(pointX - x(for: offset)) <= handleSlop {
            return .startFlag
        }
        // Inside a band: slide the whole section, keeping the grab point.
        let time = seconds(forX: pointX)
        for section in sections {
            guard let range = ranges[section.id], range.contains(time) else { continue }
            return .sectionBody(section.id, grabOffset: time - range.lowerBound)
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
        case .sectionBody(let id, let grabOffset):
            guard var section = sections.first(where: { $0.id == id }),
                  let range = MusicSection.resolvedRanges(sections, duration: duration)[id]
            else { return }
            let length = range.upperBound - range.lowerBound
            let newStart = min(max(time - grabOffset, 0), max(duration - length, 0))
            section.start = newStart
            // Moving a band keeps its length, so an explicit end follows; a
            // derived end stays derived.
            if section.end != nil { section.end = newStart + length }
            audio.setSection(section, inTrackID: trackID)
        case .creating(let anchor, _):
            let lower = min(anchor, time), upper = max(anchor, time)
            // A click (rather than a drag) means "put the playhead here",
            // not "make a zero-length section".
            guard upper - lower > 0.25 else {
                audio.musicSeek(to: lower)
                selectedSectionID = nil
                return
            }
            if let id = audio.addSection(toTrackID: trackID, start: lower, end: upper) {
                selectedSectionID = id
            }
        }
    }

    private func dropMarker() {
        if let id = audio.dropMarkerAtPlayhead() { selectedSectionID = id }
    }

    // MARK: Keyboard actions

    private func togglePlay() {
        if isHostTrack { audio.musicPlayPause() } else { audio.playTrack(id: trackID) }
    }

    private func deleteSelected() {
        guard let id = selectedSectionID else { return }
        audio.removeSection(id: id, fromTrackID: trackID)
        selectedSectionID = nil
    }

    private func toggleLoopOnSelected() {
        guard var section = sections.first(where: { $0.id == selectedSectionID }) else { return }
        section.loops.toggle()
        audio.setSection(section, inTrackID: trackID)
    }

    /// Slides the selected section, keeping its length.
    private func nudgeSelected(by delta: Double) {
        guard var section = sections.first(where: { $0.id == selectedSectionID }),
              let range = MusicSection.resolvedRanges(sections, duration: duration)[section.id]
        else { return }
        let length = range.upperBound - range.lowerBound
        let newStart = min(max(section.start + delta, 0), max(duration - length, 0))
        section.start = newStart
        if section.end != nil { section.end = newStart + length }
        audio.setSection(section, inTrackID: trackID)
    }

    /// I/O: set the selected section's in or out point to the live playhead —
    /// the by-ear way to trim a loop while it plays.
    private func setSelectedEdgeToPlayhead(start: Bool) {
        guard isHostTrack,
              var section = sections.first(where: { $0.id == selectedSectionID }) else { return }
        let time = audio.musicPosition
        if start {
            section.start = min(time, (section.end ?? duration) - 0.25)
        } else {
            section.end = max(time, section.start + 0.25)
        }
        audio.setSection(section, inTrackID: trackID)
    }

    // MARK: Table

    private var sectionTable: some View {
        List {
            if sections.isEmpty {
                Text("No sections yet — drag across the waveform to make one, or play the track and press M.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(sections) { section in
                sectionRow(section)
                    .listRowBackground(section.id == selectedSectionID
                                       ? Color.accentColor.opacity(0.18) : Color.clear)
                    .contentShape(Rectangle())
                    .onTapGesture { selectedSectionID = section.id }
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
            // A nil end means "until the next section (or the end of the
            // track)" — show that derived time greyed out instead of the bare
            // word "End", which read like a broken field.
            TimecodeField(
                label: "End",
                value: section.end,
                placeholder: MusicSection.resolvedRanges(sections, duration: duration)[section.id]
                    .map { MusicTimecode.string(from: $0.upperBound) } ?? "End"
            ) { newValue in
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
        TimecodeField(label: label, value: value, placeholder: label, onCommit: set)
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            Button("Add Section") {
                let at = isHostTrack ? audio.musicPosition : 0
                // Eight seconds is a musical-feeling default that is
                // immediately visible and draggable, rather than a
                // zero-width sliver.
                if let id = audio.addSection(toTrackID: trackID,
                                             start: at,
                                             end: min(at + 8, duration)) {
                    selectedSectionID = id
                }
            }
            Button("Prepare Audio") { audio.prepareSections(forTrackID: trackID) }
                .help("Decode every section now, so a live switch never waits")
            Spacer()
            Text("Drag the waveform to make a section · Space play · M mark · I/O trim to playhead · ←→ nudge · L loop · ⌫ delete")
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
    /// Shown when there is no explicit value — for an open-ended section this
    /// is the time it actually plays until.
    var placeholder: String
    let onCommit: (Double) -> Void

    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        TextField(placeholder, text: $text)
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
