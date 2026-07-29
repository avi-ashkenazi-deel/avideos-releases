import SwiftUI
import AppKit
import UniformTypeIdentifiers
import KeyboardShortcuts

// SoundBoardView (the pad grid) was replaced by SoundEffectsPalette in
// FloatingPalettes.swift — sounds are rows with a play/stop toggle, length,
// progress fill, and an in/out trim editor, per the Ecamm-style reference.

/// `sheet(item:)` needs an `Identifiable`, and `UUID` isn't one.
private struct IdentifiedUUID: Identifiable {
    let id: UUID
    init(_ id: UUID) { self.id = id }
}

/// Music playlist + transport.
struct MusicPlaylistView: View {
    @Environment(StudioController.self) private var studio

    /// Where the thumb is *while you drag it*.
    ///
    /// Binding the slider straight to `audio.musicPosition` had two faults at
    /// once: its setter called `musicSeek` on every tick, and each seek stops
    /// the player node and re-schedules the file — dozens of times a second
    /// through a drag. Meanwhile the position timer kept writing
    /// `musicPosition` back, so the thumb fought the pointer. Now the drag owns
    /// the value locally and one seek happens on release.
    @State private var scrubSeconds: Double?
    @State private var editingTrackID: UUID?

    private var audio: AudioEngineController { studio.audio }

    var body: some View {
        VStack(spacing: 6) {
            List {
                ForEach(audio.playlist) { track in
                    HStack {
                        if track.id == audio.currentTrackID {
                            Image(systemName: audio.isPlayingMusic ? "speaker.wave.2.fill" : "speaker.fill")
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 16)
                        } else {
                            Color.clear.frame(width: 16, height: 1)
                        }
                        Text(track.title).lineLimit(1)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { audio.playTrack(id: track.id) }
                    .contextMenu {
                        Button("Play") { audio.playTrack(id: track.id) }
                        Button("Sections…") { editingTrackID = track.id }
                        Button("Remove", role: .destructive) { audio.removeSong(id: track.id) }
                    }
                }
                .onMove { from, to in audio.moveSong(from: from, to: to) }
            }
            .listStyle(.plain)

            if !audio.musicSections.isEmpty {
                nowNextReadout
                sectionPads
            }

            // Two rows, sized for a palette window: one long HStack overflowed
            // the palette's width and silently CLIPPED the scrubber, the time
            // readout and the Sections/Add buttons — half the transport was
            // simply not on screen.
            HStack(spacing: 10) {
                Button { audio.musicPrevious() } label: { Image(systemName: "backward.fill") }
                    .help("Restart the track (from the top: previous track)")
                Button { audio.musicPlayPause() } label: {
                    Image(systemName: audio.isPlayingMusic ? "pause.fill" : "play.fill")
                }
                Button { audio.musicNext() } label: { Image(systemName: "forward.fill") }
                Button {
                    audio.loopMode = switch audio.loopMode {
                    case .off: .all
                    case .all: .one
                    case .one: .off
                    }
                } label: {
                    Image(systemName: audio.loopMode == .one ? "repeat.1" : "repeat")
                        .foregroundStyle(audio.loopMode == .off ? Color.secondary : Color.white)
                        .padding(3)
                        .background(audio.loopMode == .off ? Color.clear : Color.accentColor.opacity(0.7),
                                    in: RoundedRectangle(cornerRadius: 4))
                }
                .help("Playlist loop: off / all / one")

                Slider(value: Binding(get: { scrubSeconds ?? audio.musicPosition },
                                      set: { scrubSeconds = $0 }),
                       in: 0...max(audio.musicDuration, 1),
                       onEditingChanged: { editing in
                           // One seek, on release. Each seek stops the player
                           // node and re-schedules the file, so seeking per tick
                           // was dozens of stop/reschedules per drag.
                           if !editing, let target = scrubSeconds {
                               audio.musicSeek(to: target)
                               scrubSeconds = nil
                           }
                       })
                Text(timeString(scrubSeconds ?? audio.musicPosition)
                     + " / " + timeString(audio.musicDuration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 10)

            HStack(spacing: 10) {
                // Section controls. Disabled rather than hidden when the track
                // has no sections — a row that reflows as state changes is how
                // you click the wrong thing live.
                Picker("", selection: Binding(get: { audio.sectionSwitchMode },
                                              set: { audio.sectionSwitchMode = $0 })) {
                    Text("Cut").tag(SectionSwitchMode.hardCut)
                    Text("At loop end").tag(SectionSwitchMode.atLoopEnd)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 140)
                .disabled(audio.musicSections.isEmpty)
                .help("How a section switch happens (needs sections — mark them up via Sections…). ⌥-click a section pad to cut regardless.")

                Toggle("Loop", isOn: Binding(get: { audio.isSectionLooping },
                                             set: { audio.setSectionLoopEnabled($0) }))
                    .toggleStyle(.button)
                    .controlSize(.small)
                    .disabled(audio.playingSectionID == nil)
                    .help("Loop the playing section. The word, not a second repeat glyph — the one on the left is the playlist's.")

                Button { audio.cancelQueuedSection() } label: {
                    Image(systemName: "xmark.circle")
                }
                .disabled(audio.queuedSectionID == nil || audio.queuedSwitchIsCommitted)
                .help("Cancel the queued section (only until it's handed to the audio engine)")

                Spacer()

                Button("Sections…") {
                    editingTrackID = audio.sectionHostTrackID
                }
                .disabled(audio.sectionHostTrackID == nil)
                .help("Mark up the loaded track: start point, sections, loops")

                Button("Add…") {
                    let panel = NSOpenPanel()
                    panel.allowedContentTypes = [.audio]
                    panel.allowsMultipleSelection = true
                    if panel.runModal() == .OK { audio.addSongs(urls: panel.urls) }
                }
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
        }
        // The soundboard has accepted dropped files all along; music was
        // picker-only for no reason.
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in audio.addSongs(urls: [url]) }
                }
            }
            return true
        }
        .alert("That section can't play", isPresented: Binding(
            get: { audio.sectionFailureMessage != nil },
            set: { if !$0 { audio.sectionFailureMessage = nil } }
        )) {
            Button("OK") { audio.sectionFailureMessage = nil }
        } message: {
            Text(audio.sectionFailureMessage ?? "")
        }
        .sheet(item: Binding(get: { editingTrackID.map(IdentifiedUUID.init) },
                             set: { editingTrackID = $0?.id })) { wrapper in
            MusicSectionEditorView(trackID: wrapper.id) {
                editingTrackID = nil
                audio.prepareSections(forTrackID: wrapper.id)
            }
            .environment(studio)
        }
    }

    private func timeString(_ seconds: Double) -> String {
        MusicTimecode.shortString(from: seconds)
    }

    // MARK: - Live section control

    /// What is playing and what is next, on one line you can read at a glance
    /// while talking.
    private var nowNextReadout: some View {
        HStack(spacing: 8) {
            if let playing = audio.musicSections.first(where: { $0.id == audio.playingSectionID }) {
                Circle()
                    .fill(Color(hex: playing.colorHex))
                    .frame(width: 7, height: 7)
                Text(playing.name).font(.caption.weight(.medium)).lineLimit(1)
                if audio.isSectionLooping {
                    Image(systemName: "repeat").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text("No section").font(.caption).foregroundStyle(.secondary)
            }

            if let queued = audio.musicSections.first(where: { $0.id == audio.queuedSectionID }) {
                Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
                Text("next: \(queued.name)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let countdown = audio.secondsUntilSwitch {
                    Text(String(format: "%.1fs", max(0, countdown)))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 10)
    }

    /// One pad per section. Click fires with the current switch mode;
    /// ⌥-click always cuts, as a mid-show escape hatch that doesn't change
    /// the mode you've set.
    private var sectionPads: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(audio.musicSections) { section in
                    sectionPad(section)
                }
            }
            .padding(.horizontal, 10)
        }
        .frame(height: 34)
    }

    private func sectionPad(_ section: MusicSection) -> some View {
        let isPlaying = section.id == audio.playingSectionID
        let isQueued = section.id == audio.queuedSectionID
        let tint = Color(hex: section.colorHex)

        return Button {
            audio.playSection(id: section.id,
                              mode: NSEvent.modifierFlags.contains(.option) ? .hardCut : nil)
        } label: {
            HStack(spacing: 4) {
                Text(section.name).font(.caption).lineLimit(1)
                if let index = section.hotkeyIndex,
                   let name = KeyboardShortcuts.Name.sectionSlot(hotkeyIndex: index),
                   let shortcut = KeyboardShortcuts.getShortcut(for: name) {
                    // Truthful badge: read from the live binding, not from the
                    // slot number, so a rebind shows immediately.
                    Text(shortcut.description)
                        .font(.system(size: 9, design: .rounded))
                        .foregroundStyle(.secondary)
                }
                // Both colour and a word: colour alone fails on a dim laptop
                // panel and for colour-vision-deficient hosts.
                if isQueued {
                    Text("NEXT")
                        .font(.system(size: 8, weight: .bold))
                        .padding(.horizontal, 3)
                        .background(Capsule().fill(.white.opacity(0.25)))
                }
            }
            .padding(.horizontal, 8)
            .frame(minWidth: 84, minHeight: 26)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(isPlaying ? tint.opacity(0.85) : tint.opacity(0.15)))
            .overlay(RoundedRectangle(cornerRadius: 6)
                .stroke(isQueued ? tint : .clear, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])))
            .foregroundStyle(isPlaying ? Color.white : .primary)
        }
        .buttonStyle(.plain)
        .help(section.name)
    }
}

/// Guest session panel: start/end session, invite link + QR, guest rows with
/// upload health, take controls.
struct GuestsPanelView: View {
    @Environment(StudioController.self) private var studio
    @State private var showingQR = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let guests = studio.guests {
                switch guests.state {
                case .disconnected, .failed:
                    startSection(guests)
                case .connecting:
                    ProgressView("Connecting…")
                case .connected:
                    connectedSection(guests)
                }
            }
        }
        .padding(10)
    }

    private func startSection(_ guests: GuestSessionController) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .failed(let message) = guests.state {
                Text(message).font(.caption).foregroundStyle(.red)
            }
            Button {
                Task { await studio.startGuestSession() }
            } label: {
                Label("Start Guest Session", systemImage: "person.2.badge.plus")
            }
            .buttonStyle(.borderedProminent)
            .disabled(studio.workerBaseURL == nil)
            if studio.workerBaseURL == nil {
                Text("Set the session server URL in Settings first.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func connectedSection(_ guests: GuestSessionController) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let invite = guests.inviteURL {
                HStack {
                    Text(invite.absoluteString)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Button("Copy") { InviteLinkBuilder.copyToClipboard(invite) }
                    Button {
                        showingQR.toggle()
                    } label: {
                        Image(systemName: "qrcode")
                    }
                    .popover(isPresented: $showingQR) {
                        if let qr = InviteLinkBuilder.qrCode(for: invite) {
                            Image(nsImage: qr)
                                .resizable()
                                .frame(width: 220, height: 220)
                                .padding()
                        }
                    }
                }
            }

            HStack {
                if studio.podcast.isTakeRunning {
                    Button {
                        Task { await studio.podcast.stopTake() }
                    } label: {
                        Label("Stop Take", systemImage: "stop.circle.fill")
                    }
                    .tint(.red)
                    TakeTimer(state: studio.podcast.takeState)
                } else {
                    Button {
                        studio.podcast.startTake()
                    } label: {
                        Label("Record Take", systemImage: "record.circle")
                    }
                    .tint(.red)
                }
                Spacer()
                Button("End Session") {
                    Task { await studio.endGuestSession() }
                }
            }

            Divider()

            ForEach(guests.guests) { guest in
                guestRow(guest)
            }
            if guests.guests.isEmpty {
                Text("Waiting for guests to join…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func guestRow(_ guest: GuestParticipant) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Circle()
                    .fill(guest.hasVideo ? Color.green : Color.gray)
                    .frame(width: 7, height: 7)
                Text(guest.displayName).fontWeight(.medium)
                if guest.isRecordingLocally {
                    Image(systemName: "record.circle").foregroundStyle(.red).font(.caption)
                }
                Spacer()
                Toggle("Mute", isOn: Binding(
                    get: { studio.audio.isMuted(.guest(guest.identity)) },
                    set: { studio.audio.setMuted($0, for: .guest(guest.identity)) }
                ))
                .toggleStyle(.button)
                .controlSize(.small)
            }
            if let progress = guest.uploadProgress {
                HStack(spacing: 6) {
                    ProgressView(value: progress).frame(width: 110)
                    Text("upload \(Int(progress * 100))% · \(guest.uploadQueuedChunks) queued")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if let error = guest.lastError {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 3)
    }
}

private struct TakeTimer: View {
    let state: RecordingSessionController.TakeState

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            if case .recording(_, let startedAt) = state {
                let elapsed = Int(timeline.date.timeIntervalSince(startedAt))
                Text(String(format: "%d:%02d", elapsed / 60, elapsed % 60))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(.red)
            }
        }
    }
}

/// Virtual camera + virtual mic status card (onboarding + settings).
///
/// A dev build (scripts/dev-app-only.sh) ships without the camera extension
/// and audio driver payloads, so "Install" could only fail with a raw error.
/// Each card checks its payload is actually in the bundle first and explains
/// the dev build when it isn't, instead of offering a dead button.
struct DriverStatusView: View {
    @Environment(StudioController.self) private var studio
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GroupBox("Virtual Camera") {
                if cameraExtensionBundled {
                    HStack {
                        statusDot(installed: studio.virtualCamera.status == .installed)
                        Text(studio.virtualCamera.status.displayText)
                        Spacer()
                        Button("Install Camera Extension") {
                            studio.virtualCamera.activate()
                        }
                    }
                    if studio.virtualCamera.status == .pendingApproval {
                        Text("Approve it in System Settings › General › Login Items & Extensions.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    devBuildExplanation(component: "camera extension",
                                        consequence: "The app won't appear as a camera in Zoom or Meet.")
                }
            }

            GroupBox("Virtual Microphone") {
                if audioDriverBundled {
                    HStack {
                        statusDot(installed: studio.audio.driverStatus == .installed)
                        Text(studio.audio.driverStatus.displayText)
                        Spacer()
                        switch studio.audio.driverStatus {
                        case .installed:
                            Button("Uninstall", role: .destructive) {
                                run { await studio.audio.uninstallDriver() }
                            }
                        default:
                            Button(busy ? "Installing…" : "Install Virtual Mic") {
                                run { await studio.audio.installDriver() }
                            }
                            .disabled(busy)
                        }
                    }
                    Text("Installing needs your admin password and blips system audio for about a second — don't do it mid-show.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    devBuildExplanation(component: "audio driver",
                                        consequence: "Zoom won't list a streamit microphone; everything else works.")
                }
            }
        }
    }

    // MARK: - Dev-build detection

    /// The camera extension embeds at Contents/Library/SystemExtensions when
    /// the full project is generated; the dev spec comments that dependency out.
    private var cameraExtensionBundled: Bool {
        let dir = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Library/SystemExtensions")
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil)) ?? []
        return contents.contains { $0.pathExtension == "systemextension" }
    }

    /// The driver install payload is copied into Resources by the full build
    /// (and also needs libASPL vendored — see docs/DEV_SETUP.md).
    private var audioDriverBundled: Bool {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("StreamitAudio.driver")
        else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    private func devBuildExplanation(component: String, consequence: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                statusDot(installed: false)
                Text("Not included in this build")
            }
            Text("This is a development build (scripts/dev-app-only.sh), so the \(component) isn't inside the app and there is nothing to install. \(consequence) Run ./scripts/dev-app-only.sh --restore and rebuild with a Developer ID to get it.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusDot(installed: Bool) -> some View {
        Circle()
            .fill(installed ? Color.green : Color.orange)
            .frame(width: 8, height: 8)
    }

    private func run(_ work: @escaping () async -> Void) {
        busy = true
        Task {
            await work()
            busy = false
        }
    }
}

/// Compact live stats: fps, dropped frames, REC state.
struct StatsHUD: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            HStack(spacing: 10) {
                if let engine = studio.renderEngine {
                    Text("\(engine.clock.fps) fps target")
                    Text("\(engine.droppedFrames) dropped")
                        .foregroundStyle(engine.droppedFrames > 0 ? .orange : .secondary)
                    Text(String(format: "%.1f ms", engine.lastFrameDuration * 1000))
                }
                if studio.virtualCamera.isStreaming {
                    Label("Virtual Cam", systemImage: "video.fill")
                        .foregroundStyle(.green)
                }
                if studio.isRecording {
                    Label("REC", systemImage: "record.circle.fill")
                        .foregroundStyle(.red)
                }
            }
            .font(.caption.monospacedDigit())
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
        self.init(.sRGB,
                  red: Double((value >> 16) & 0xFF) / 255,
                  green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255,
                  opacity: 1)
    }
}
