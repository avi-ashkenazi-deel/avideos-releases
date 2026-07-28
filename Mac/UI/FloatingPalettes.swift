import SwiftUI
import AppKit
import AVFoundation
import UniformTypeIdentifiers
import KeyboardShortcuts

/// The Ecamm-style studio chrome: every control surface is an INDEPENDENT
/// floating window (not a view inside the studio window) — movable anywhere,
/// across displays, closed with its own close button, opened from the icon
/// strip on the preview. Windows float above the studio, hide when the app
/// deactivates, and remember their frames via autosave names.
///
/// Scene side: `StreamitApp` declares `WindowGroup(id: "palette",
/// for: PaletteKind.self)`; the strip opens one via
/// `openWindow(id: "palette", value: kind)` — the same value refocuses the
/// existing window instead of duplicating it.

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

}

// MARK: - Palette windows

/// Content of one palette window. Each palette is a real, independent macOS
/// window: `StreamitApp` declares `WindowGroup(id: "palette",
/// for: PaletteKind.self)` and this view is its body.
struct PaletteWindowContent: View {
    let kind: PaletteKind
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        content
            .frame(width: kind.width)
            .navigationTitle(kind.title)
            .background(PaletteWindowConfigurator(kind: kind))
    }

    @ViewBuilder
    private var content: some View {
        switch kind {
        case .scenes:
            SceneListView()
                .frame(height: 360)
        case .overlays:
            OverlaysPalette(openInspector: {
                openWindow(id: "palette", value: PaletteKind.inspector)
            })
        case .sounds:
            SoundEffectsPalette()
        case .levels:
            MixerPanelView()   // rows size themselves; the ducker sits below
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
}

/// Turns the plain WindowGroup window into a studio palette: floats above
/// the studio window, hides when the app deactivates, drags by its body,
/// keeps its frame per palette, and drops minimize/zoom (a palette is
/// closed, not minimized).
private struct PaletteWindowConfigurator: NSViewRepresentable {
    let kind: PaletteKind

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        // The window doesn't exist until the view lands in one.
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.level = .floating
            window.hidesOnDeactivate = true
            window.isMovableByWindowBackground = true
            window.titlebarAppearsTransparent = true
            window.standardWindowButton(.miniaturizeButton)?.isHidden = true
            window.standardWindowButton(.zoomButton)?.isHidden = true
            window.collectionBehavior.insert(.fullScreenAuxiliary)
            window.setFrameAutosaveName("palette-\(kind.rawValue)")
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// The icon strip on the preview's right edge — one button per palette.
/// Clicking opens the palette window (or brings the existing one forward;
/// same value never duplicates). Palettes close with their own close button.
struct PaletteStrip: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 10) {
            ForEach(PaletteKind.allCases) { kind in
                Button {
                    openWindow(id: "palette", value: kind)
                } label: {
                    Image(systemName: kind.icon)
                        .font(.system(size: 15))
                        .frame(width: 34, height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: 7)
                                .fill(Color.white.opacity(0.08))
                        )
                }
                .buttonStyle(.plain)
                .help(kind.title)
            }
        }
        .padding(6)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
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
            // Camera / guest PiP tiles — the host small over a screen share.
            Menu {
                Section("Cameras") {
                    ForEach(CameraSource.availableCameras(), id: \.uniqueID) { device in
                        Button(device.localizedName) {
                            studio.addCameraElement(deviceUniqueID: device.uniqueID,
                                                    name: device.localizedName)
                        }
                    }
                }
                if let guests = studio.guests?.guests, !guests.isEmpty {
                    Section("Guests") {
                        ForEach(guests) { guest in
                            Button(guest.displayName) {
                                studio.addGuestElement(identity: guest.identity,
                                                       name: guest.displayName)
                            }
                        }
                    }
                }
            } label: {
                Image(systemName: "video.badge.plus")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Add a camera or guest tile")
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
                        // Top-level sounds first, then one disclosure per
                        // folder — folders exist only through their members.
                        ForEach(audio.pads.filter { $0.folder == nil }) { pad in
                            SoundEffectRow(pad: pad)
                        }
                        ForEach(audio.padFolders, id: \.self) { folder in
                            DisclosureGroup {
                                ForEach(audio.pads.filter { $0.folder == folder }) { pad in
                                    SoundEffectRow(pad: pad)
                                }
                            } label: {
                                Label(folder, systemImage: "folder.fill")
                                    .font(.caption.weight(.medium))
                            }
                            .padding(.horizontal, 4)
                        }
                    }
                    .padding(6)
                }
                .frame(height: min(340, max(90, CGFloat(audio.pads.count + audio.padFolders.count) * 34 + 16)))
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
    @State private var newFolderText = ""
    @State private var isNamingFolder = false

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
            Menu("Move to Folder") {
                if pad.folder != nil {
                    Button("Top Level") { audio.setPadFolder(id: pad.id, folder: nil) }
                }
                ForEach(audio.padFolders.filter { $0 != pad.folder }, id: \.self) { folder in
                    Button(folder) { audio.setPadFolder(id: pad.id, folder: folder) }
                }
                Divider()
                Button("New Folder…") {
                    newFolderText = ""
                    isNamingFolder = true
                }
            }
            Button("Remove", role: .destructive) { audio.removePad(id: pad.id) }
        }
        .alert("Rename Sound", isPresented: $isRenaming) {
            TextField("Name", text: $renameText)
            Button("Rename") { audio.renamePad(id: pad.id, to: renameText) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Folder", isPresented: $isNamingFolder) {
            TextField("Name", text: $newFolderText)
            Button("Create") { audio.setPadFolder(id: pad.id, folder: newFolderText) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(pad.name) moves into the new folder.")
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
