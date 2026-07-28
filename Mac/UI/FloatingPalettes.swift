import SwiftUI
import AppKit
import UniformTypeIdentifiers
import KeyboardShortcuts

/// The Ecamm-style studio chrome: every control surface is a small floating
/// palette sitting on the live preview itself, draggable by its title bar and
/// toggleable from the icon strip on the right edge. The preview is the
/// window; the palettes are furniture on top of it.
///
/// Positions and the open set persist across launches (UserDefaults — this is
/// window furniture, not document state, so it stays out of the project file).

// MARK: - Palette catalogue

enum PaletteKind: String, CaseIterable, Codable, Identifiable {
    case scenes
    case overlays
    case sounds
    case levels
    case music
    case guests
    case inspector
    case setup

    var id: String { rawValue }

    var title: String {
        switch self {
        case .scenes: "Scenes"
        case .overlays: "Overlays"
        case .sounds: "Sound Effects"
        case .levels: "Sound Levels"
        case .music: "Music"
        case .guests: "Interview"
        case .inspector: "Inspector"
        case .setup: "Setup"
        }
    }

    var icon: String {
        switch self {
        case .scenes: "rectangle.stack"
        case .overlays: "square.3.layers.3d.top.filled"
        case .sounds: "speaker.wave.2"
        case .levels: "slider.horizontal.3"
        case .music: "music.note.list"
        case .guests: "person.2"
        case .inspector: "sidebar.right"
        case .setup: "gearshape.2"
        }
    }

    var width: CGFloat {
        switch self {
        case .scenes: 220
        case .overlays: 280
        case .sounds: 300
        case .levels: 460
        case .music: 340
        case .guests: 320
        case .inspector: 300
        case .setup: 360
        }
    }

    /// Where a palette lands the first time it opens (top-leading offsets).
    var defaultPosition: CGPoint {
        switch self {
        case .scenes: CGPoint(x: 16, y: 48)
        case .overlays: CGPoint(x: 252, y: 48)
        case .sounds: CGPoint(x: 16, y: 420)
        case .levels: CGPoint(x: 340, y: 500)
        case .music: CGPoint(x: 550, y: 48)
        case .guests: CGPoint(x: 550, y: 380)
        case .inspector: CGPoint(x: 900, y: 48)
        case .setup: CGPoint(x: 340, y: 200)
        }
    }
}

// MARK: - Board (open set + positions + the icon strip)

struct PaletteBoard: View {
    @Environment(StudioController.self) private var studio

    /// Open palettes in z-order — last is frontmost.
    @State private var open: [PaletteKind] = []
    @State private var positions: [PaletteKind: CGPoint] = [:]
    @State private var restored = false

    private static let defaultsKey = "paletteBoard.v1"

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(open) { kind in
                FloatingPalette(
                    title: kind.title,
                    position: binding(for: kind),
                    onRaise: { raise(kind) },
                    onClose: { close(kind) }
                ) {
                    content(for: kind)
                }
                .frame(width: kind.width)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .trailing) { iconStrip.padding(.trailing, 8) }
        .onAppear(perform: restore)
        .onChange(of: open) { persist() }
        .onChange(of: positions) { persist() }
    }

    @ViewBuilder
    private func content(for kind: PaletteKind) -> some View {
        switch kind {
        case .scenes:
            SceneListView()
                .frame(height: 360)
        case .overlays:
            OverlaysPalette(openInspector: { openIfNeeded(.inspector) })
        case .sounds:
            SoundEffectsPalette()
        case .levels:
            MixerPanelView()
                .frame(height: 320)
        case .music:
            MusicPlaylistView()
                .frame(height: 380)
        case .guests:
            GuestsPanelView()
                .frame(height: 320)
        case .inspector:
            InspectorView()
                .frame(height: 520)
        case .setup:
            ScrollView { DriverStatusView().padding(10) }
                .frame(height: 320)
        }
    }

    /// The right-edge toggle strip — one icon per palette, filled when open.
    private var iconStrip: some View {
        VStack(spacing: 10) {
            ForEach(PaletteKind.allCases) { kind in
                Button {
                    if open.contains(kind) { close(kind) } else { openIfNeeded(kind) }
                } label: {
                    Image(systemName: kind.icon)
                        .font(.system(size: 15))
                        .frame(width: 34, height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: 7)
                                .fill(open.contains(kind) ? Color.accentColor.opacity(0.55)
                                                          : Color.white.opacity(0.08))
                        )
                }
                .buttonStyle(.plain)
                .help(kind.title)
            }
        }
        .padding(6)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: State plumbing

    private func binding(for kind: PaletteKind) -> Binding<CGPoint> {
        Binding(
            get: { positions[kind] ?? kind.defaultPosition },
            set: { positions[kind] = $0 }
        )
    }

    private func openIfNeeded(_ kind: PaletteKind) {
        if let index = open.firstIndex(of: kind) {
            open.remove(at: index)
        }
        open.append(kind)   // end of array = frontmost
    }

    private func raise(_ kind: PaletteKind) {
        guard open.last != kind, let index = open.firstIndex(of: kind) else { return }
        open.remove(at: index)
        open.append(kind)
    }

    private func close(_ kind: PaletteKind) {
        open.removeAll { $0 == kind }
    }

    // MARK: Persistence

    private struct BoardState: Codable {
        var open: [PaletteKind]
        var positions: [String: CGPoint]
    }

    private func restore() {
        guard !restored else { return }
        restored = true
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let state = try? JSONDecoder().decode(BoardState.self, from: data) {
            open = state.open
            positions = Dictionary(uniqueKeysWithValues: state.positions.compactMap { key, point in
                PaletteKind(rawValue: key).map { ($0, point) }
            })
        } else {
            open = [.scenes, .overlays, .sounds, .levels]
        }
    }

    private func persist() {
        guard restored else { return }
        let state = BoardState(open: open,
                               positions: Dictionary(uniqueKeysWithValues:
                                   positions.map { ($0.key.rawValue, $0.value) }))
        if let data = try? JSONEncoder().encode(state) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}

// MARK: - Palette chrome

/// Title bar + material card around any palette content. Dragging the title
/// bar moves it; clicking anywhere raises it.
struct FloatingPalette<Content: View>: View {
    let title: String
    @Binding var position: CGPoint
    let onRaise: () -> Void
    let onClose: () -> Void
    @ViewBuilder let content: Content

    @GestureState private var dragOffset: CGSize = .zero

    var body: some View {
        VStack(spacing: 0) {
            titleBar
            Divider()
            content
        }
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.12)))
        .shadow(color: .black.opacity(0.45), radius: 14, y: 6)
        .offset(x: position.x + dragOffset.width, y: position.y + dragOffset.height)
        .simultaneousGesture(TapGesture().onEnded { onRaise() })
    }

    private var titleBar: some View {
        HStack(spacing: 6) {
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            Spacer()
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            // Balances the close button so the title stays centered.
            Image(systemName: "xmark.circle.fill").opacity(0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(coordinateSpace: .global)
                .updating($dragOffset) { value, state, _ in
                    state = value.translation
                }
                .onEnded { value in
                    position = CGPoint(x: max(0, position.x + value.translation.width),
                                       y: max(0, position.y + value.translation.height))
                }
        )
    }
}

// MARK: - Overlays palette (the layers panel)

/// Element list for the active scene: eye to show/hide (with the element's
/// entry/exit animation), drag to reorder z, gear to inspect, plus the
/// add-element row. Topmost layer is listed first.
struct OverlaysPalette: View {
    @Environment(StudioController.self) private var studio
    var openInspector: () -> Void

    private var elements: [Element] {
        studio.project.activeScene?.elements ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            if elements.isEmpty {
                Text("No overlays in this scene yet — add one below.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 90)
                    .padding(.horizontal, 12)
            } else {
                List {
                    // Array order is draw order (last on top); the panel shows
                    // the topmost layer first, so display reversed and map
                    // indices back for moves.
                    ForEach(elements.reversed()) { element in
                        OverlayRow(element: element,
                                   isSelected: studio.selectedElementID == element.id,
                                   select: { studio.selectedElementID = element.id },
                                   toggleEye: { studio.toggleElementVisibility(id: element.id) },
                                   inspect: {
                                       studio.selectedElementID = element.id
                                       openInspector()
                                   },
                                   remove: { studio.removeElement(id: element.id) })
                    }
                    .onMove { displayFrom, displayTo in
                        let count = elements.count
                        let arrayFrom = IndexSet(displayFrom.map { count - 1 - $0 })
                        let arrayTo = count - displayTo
                        studio.moveElements(fromOffsets: arrayFrom, toOffset: arrayTo)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .frame(height: min(320, max(120, CGFloat(elements.count) * 34 + 20)))
            }

            Divider()
            HStack {
                AddElementButtons()
                Spacer()
                Button {
                    if let id = studio.selectedElementID { studio.removeElement(id: id) }
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .disabled(studio.selectedElementID == nil)
                .help("Remove the selected overlay")
            }
            .padding(8)
        }
    }
}

private struct OverlayRow: View {
    let element: Element
    let isSelected: Bool
    let select: () -> Void
    let toggleEye: () -> Void
    let inspect: () -> Void
    let remove: () -> Void

    private var kindIcon: String {
        switch element.kind {
        case .text: "textformat"
        case .shape: "square.on.circle"
        case .image: "photo"
        case .video: "film"
        case .web: "globe"
        case .source: "camera"
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            Button(action: toggleEye) {
                Image(systemName: element.isVisible ? "eye.fill" : "eye.slash")
                    .foregroundStyle(element.isVisible ? .primary : .tertiary)
            }
            .buttonStyle(.plain)
            .help(element.isVisible ? "Hide (plays the exit animation)" : "Show")

            Image(systemName: kindIcon)
                .foregroundStyle(.secondary)
                .frame(width: 16)

            Text(element.name)
                .lineLimit(1)
                .foregroundStyle(element.isVisible ? .primary : .secondary)

            Spacer()

            Button(action: inspect) {
                Image(systemName: "slider.horizontal.3")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Open in the inspector")
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .listRowBackground(isSelected ? Color.accentColor.opacity(0.25) : Color.clear)
        .contextMenu {
            Button("Inspect", action: inspect)
            Button("Remove", role: .destructive, action: remove)
        }
    }
}

/// The add-element row, shared by the overlays palette and the inspector.
struct AddElementButtons: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        HStack {
            Button { studio.addTextElement() } label: { Image(systemName: "textformat") }
                .help("Add text")
            Button { studio.addShapeElement() } label: { Image(systemName: "square.on.circle") }
                .help("Add shape")
            Button { addMedia(images: true) } label: { Image(systemName: "photo") }
                .help("Add image")
            Button { addMedia(images: false) } label: { Image(systemName: "film") }
                .help("Add video")
            Button { studio.addWebElement() } label: { Image(systemName: "globe") }
                .help("Add web page")
        }
        .buttonStyle(.borderless)
    }

    private func addMedia(images: Bool) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = images ? [.image] : [.movie, .mpeg4Movie, .quickTimeMovie]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if images {
            studio.addImageElement(url: url)
        } else {
            studio.addVideoElement(url: url)
        }
    }
}

// MARK: - Sound effects palette (rows, not tiles)

/// One line per sound: play/stop, name, length, a progress fill while
/// sounding, and a trim editor for in/out points behind the gear.
struct SoundEffectsPalette: View {
    @Environment(StudioController.self) private var studio

    private var audio: AudioEngineController { studio.audio }

    var body: some View {
        VStack(spacing: 0) {
            if audio.pads.isEmpty {
                Text("Drop audio files here, or add one below.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(audio.pads) { pad in
                            SoundEffectRow(pad: pad)
                        }
                    }
                    .padding(6)
                }
                .frame(height: min(320, max(90, CGFloat(audio.pads.count) * 34 + 16)))
            }

            Divider()
            HStack {
                Button {
                    let panel = NSOpenPanel()
                    panel.allowedContentTypes = [.audio]
                    panel.allowsMultipleSelection = true
                    if panel.runModal() == .OK {
                        panel.urls.forEach { audio.addPad(fileURL: $0) }
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .help("Add sounds")

                Spacer()

                Button {
                    audio.padPlayer?.stopAll()
                } label: {
                    Image(systemName: "stop.fill")
                }
                .help("Stop all sounds")
            }
            .buttonStyle(.borderless)
            .padding(8)
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in audio.addPad(fileURL: url) }
                }
            }
            return true
        }
    }
}

private struct SoundEffectRow: View {
    @Environment(StudioController.self) private var studio
    let pad: SoundPad

    @State private var showingTrim = false
    @State private var renameText = ""
    @State private var isRenaming = false

    private var audio: AudioEngineController { studio.audio }
    private var progress: Double? { audio.padProgress[pad.id] }
    private var isPlaying: Bool { progress != nil }

    /// The length that will actually play (trim window, not the file).
    private var playLength: Double? {
        guard let full = audio.padDuration(id: pad.id) else { return nil }
        let start = min(max(pad.trimStart ?? 0, 0), full)
        let end = min(max(pad.trimEnd ?? full, start), full)
        return end - start
    }

    private var assignedShortcutBadge: String? {
        guard let index = pad.hotkeyIndex,
              let name = KeyboardShortcuts.Name.padSlot(hotkeyIndex: index),
              let shortcut = KeyboardShortcuts.getShortcut(for: name) else { return nil }
        return shortcut.description
    }

    var body: some View {
        HStack(spacing: 8) {
            Button {
                audio.playPad(pad)
            } label: {
                Image(systemName: isPlaying ? "stop.fill" : "play.fill")
                    .foregroundStyle(Color(hex: pad.colorHex))
                    .frame(width: 18)
            }
            .buttonStyle(.plain)

            Text(pad.name)
                .lineLimit(1)

            if let badge = assignedShortcutBadge {
                Text(badge)
                    .font(.system(size: 9, design: .monospaced))
                    .padding(.horizontal, 4)
                    .background(.black.opacity(0.3), in: Capsule())
            }

            Spacer()

            if let playLength {
                Text(Self.timecode(playLength))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Button {
                showingTrim = true
            } label: {
                Image(systemName: "gearshape.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Trim in/out points")
            .popover(isPresented: $showingTrim) {
                PadTrimEditor(pad: pad)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(alignment: .leading) {
            // Playback progress as a fill sweeping the row.
            GeometryReader { geo in
                if let progress {
                    Rectangle()
                        .fill(Color(hex: pad.colorHex).opacity(0.28))
                        .frame(width: geo.size.width * progress)
                }
            }
        }
        .background(.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contextMenu {
            Button("Rename…") {
                renameText = pad.name
                isRenaming = true
            }
            Button("Remove", role: .destructive) { audio.removePad(id: pad.id) }
        }
        .alert("Rename Sound", isPresented: $isRenaming) {
            TextField("Name", text: $renameText)
            Button("Rename") { audio.renamePad(id: pad.id, to: renameText) }
            Button("Cancel", role: .cancel) {}
        }
    }

    static func timecode(_ seconds: Double) -> String {
        let total = max(0, seconds)
        let minutes = Int(total) / 60
        let secs = total - Double(minutes * 60)
        return String(format: "%d:%04.1f", minutes, secs)
    }
}

/// In/out points over the full decoded length. Commits on slider release —
/// each commit persists audio settings, so mid-drag writes would be churn.
private struct PadTrimEditor: View {
    @Environment(StudioController.self) private var studio
    let pad: SoundPad

    @State private var start: Double = 0
    @State private var end: Double = 0
    @State private var loaded = false

    private var audio: AudioEngineController { studio.audio }
    private var full: Double { audio.padDuration(id: pad.id) ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(pad.name).font(.headline)
            if full > 0 {
                LabeledContent("In") {
                    Text(SoundEffectRow.timecode(start)).monospacedDigit()
                }
                Slider(value: $start, in: 0...full) { editing in
                    if !editing { commit() }
                }
                LabeledContent("Out") {
                    Text(SoundEffectRow.timecode(end)).monospacedDigit()
                }
                Slider(value: $end, in: 0...full) { editing in
                    if !editing { commit() }
                }
                HStack {
                    Text("Plays \(SoundEffectRow.timecode(max(0, end - start))) of \(SoundEffectRow.timecode(full))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Reset") {
                        start = 0
                        end = full
                        audio.setPadTrim(id: pad.id, start: nil, end: nil)
                    }
                }
            } else {
                Text("This sound isn't decoded — re-add the file.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(width: 300)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            start = min(max(pad.trimStart ?? 0, 0), full)
            end = min(max(pad.trimEnd ?? full, 0), full)
        }
    }

    private func commit() {
        // Keep at least a 50ms window so a pad can't be trimmed into silence.
        if end < start + 0.05 { end = min(start + 0.05, full) }
        let isFull = start <= 0.005 && end >= full - 0.005
        audio.setPadTrim(id: pad.id,
                         start: isFull ? nil : start,
                         end: isFull ? nil : end)
    }
}
