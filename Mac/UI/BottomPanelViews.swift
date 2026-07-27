import SwiftUI
import UniformTypeIdentifiers
import KeyboardShortcuts

/// Soundboard grid: colored pads with hotkey badges + progress rings,
/// drag-drop audio files to add.
struct SoundBoardView: View {
    @Environment(StudioController.self) private var studio

    private var audio: AudioEngineController { studio.audio }

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 8)], spacing: 8) {
                ForEach(audio.pads) { pad in
                    PadButton(pad: pad,
                              progress: audio.padProgress[pad.id],
                              play: { audio.playPad(pad) },
                              remove: { audio.removePad(id: pad.id) },
                              rename: { audio.renamePad(id: pad.id, to: $0) })
                }
                addPadTile
            }
            .padding(10)
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

    private var addPadTile: some View {
        Button {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.audio]
            panel.allowsMultipleSelection = true
            if panel.runModal() == .OK {
                panel.urls.forEach { audio.addPad(fileURL: $0) }
            }
        } label: {
            VStack {
                Image(systemName: "plus")
                Text("Add Sound").font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}

private struct PadButton: View {
    let pad: SoundPad
    let progress: Double?
    let play: () -> Void
    let remove: () -> Void
    let rename: (String) -> Void

    @State private var renameText = ""
    @State private var isRenaming = false

    /// The global hotkey currently bound to this pad's slot, e.g. "⌥3".
    private var assignedShortcutBadge: String? {
        guard let index = pad.hotkeyIndex,
              let name = KeyboardShortcuts.Name.padSlot(hotkeyIndex: index),
              let shortcut = KeyboardShortcuts.getShortcut(for: name) else { return nil }
        return shortcut.description
    }

    var body: some View {
        Button(action: play) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(hex: pad.colorHex).opacity(0.75))
                VStack(spacing: 3) {
                    Text(pad.name)
                        .font(.caption.bold())
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                    // The real assigned combo, not an assumed one: the host can
                    // rebind these in Settings → Shortcuts, and an unbound pad
                    // must not advertise a key that does nothing.
                    if let badge = assignedShortcutBadge {
                        Text(badge)
                            .font(.system(size: 9, design: .monospaced))
                            .padding(.horizontal, 4)
                            .background(.black.opacity(0.3), in: Capsule())
                    }
                }
                .padding(6)
                if let progress {
                    RoundedRectangle(cornerRadius: 8)
                        .trim(from: 0, to: progress)
                        .stroke(Color.white, lineWidth: 2.5)
                }
            }
            .frame(minHeight: 56)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Rename…") {
                renameText = pad.name
                isRenaming = true
            }
            Button("Remove", role: .destructive, action: remove)
        }
        .alert("Rename Pad", isPresented: $isRenaming) {
            TextField("Name", text: $renameText)
            Button("Rename") { rename(renameText) }
            Button("Cancel", role: .cancel) {}
        }
    }
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
                        Button("Remove", role: .destructive) { audio.removeSong(id: track.id) }
                    }
                }
                .onMove { from, to in audio.moveSong(from: from, to: to) }
            }
            .listStyle(.plain)

            HStack(spacing: 10) {
                Button { audio.musicPrevious() } label: { Image(systemName: "backward.fill") }
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
                        .foregroundStyle(audio.loopMode == .off ? Color.secondary : Color.accentColor)
                }

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
    }

    private func timeString(_ seconds: Double) -> String {
        let total = Int(max(0, seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
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
struct DriverStatusView: View {
    @Environment(StudioController.self) private var studio
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GroupBox("Virtual Camera") {
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
            }

            GroupBox("Virtual Microphone") {
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
            }
        }
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
