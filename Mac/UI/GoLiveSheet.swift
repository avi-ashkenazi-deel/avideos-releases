import SwiftUI

/// Go Live: tick where the show goes, check the upload estimate, go. While
/// live the same sheet is the control room: one row per destination with
/// its state, bitrate and a per-destination stop/start, and End Stream.
struct GoLiveSheet: View {
    @Environment(StudioController.self) private var studio
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    @State private var selection: Set<UUID> = []
    @State private var isStarting = false
    @State private var confirmsEnd = false

    private var live: LiveStreamController { studio.live }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if live.destinations.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(live.destinations) { destination in
                            GoLiveRow(destination: destination,
                                      isSelected: selection.contains(destination.id),
                                      toggle: { toggle(destination.id) })
                        }
                    }
                    .padding(12)
                }
                .frame(minHeight: 220)
            }
            Divider()
            footer
        }
        .frame(width: 560)
        .frame(minHeight: 380)
        .onAppear {
            selection = Set(live.destinations.filter { $0.isEnabled }.map(\.id))
                .union(live.liveDestinationIDs)
        }
        .confirmationDialog("End the stream on every destination?",
                            isPresented: $confirmsEnd) {
            Button("End Stream", role: .destructive) {
                live.endLive()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.title2)
                .foregroundStyle(live.isLive ? Color.red : Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(live.isLive ? "You're live" : "Go Live")
                    .font(.title3.weight(.semibold))
                if live.isLive, let startedAt = live.startedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("\(Timecode.clock(context.date.timeIntervalSince(startedAt))) · \(live.totalKilobitsPerSecond) kbps out")
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Every ticked destination gets the show at once. Horizontal and vertical can run together.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(16)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("No destinations yet")
                .font(.headline)
            Text("Add YouTube, LinkedIn, X, Twitch, Instagram, TikTok or any RTMP server in Settings → Streaming.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Open Streaming Settings") {
                dismiss()
                openSettings()
            }
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .padding()
    }

    private var footer: some View {
        let pending = selection.subtracting(live.liveDestinationIDs)
        let mbps = live.estimatedUploadMbps(for: selection)
        return HStack(spacing: 10) {
            if !selection.isEmpty {
                Label("\(mbps, specifier: "%.1f") Mbps upload", systemImage: "arrow.up.circle")
                    .font(.callout)
                    .foregroundStyle(mbps > 20 ? Color.orange : Color.secondary)
                    .help("What every ticked destination needs together, including overhead.")
            }
            Spacer()
            Button("Comments") { openWindow(id: "comments") }
            if live.isLive {
                if !pending.isEmpty {
                    Button("Add \(pending.count) Destination\(pending.count == 1 ? "" : "s")") {
                        start(pending)
                    }
                }
                Button("End Stream", role: .destructive) { confirmsEnd = true }
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    start(selection)
                } label: {
                    Text(isStarting ? "Starting…" : "Go Live")
                        .frame(minWidth: 80)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(selection.isEmpty || isStarting)
            }
        }
        .padding(14)
    }

    private func toggle(_ id: UUID) {
        if live.liveDestinationIDs.contains(id) {
            live.stopDestination(id: id)
            selection.remove(id)
        } else if selection.contains(id) {
            selection.remove(id)
        } else {
            selection.insert(id)
        }
    }

    private func start(_ ids: Set<UUID>) {
        isStarting = true
        Task {
            await live.goLive(destinationIDs: ids)
            isStarting = false
        }
    }
}

private struct GoLiveRow: View {
    @Environment(StudioController.self) private var studio
    let destination: StreamDestination
    let isSelected: Bool
    let toggle: () -> Void

    private var live: LiveStreamController { studio.live }
    private var isLive: Bool { live.liveDestinationIDs.contains(destination.id) }

    var body: some View {
        HStack(spacing: 10) {
            Button(action: toggle) {
                Image(systemName: isLive ? "stop.circle.fill" : (isSelected ? "checkmark.square.fill" : "square"))
                    .font(.title3)
                    .foregroundStyle(isLive ? Color.red : (isSelected ? Color.accentColor : Color.secondary))
            }
            .buttonStyle(.plain)
            .help(isLive ? "Stop this destination (the others keep going)" : "Include this destination")
            PlatformBadge(platform: destination.platform)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(destination.name).font(.body.weight(.medium))
                    Text(destination.orientation.shortName)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 4)
                        .background(Color.secondary.opacity(0.2), in: RoundedRectangle(cornerRadius: 3))
                }
                statusLine
            }
            Spacer()
            if let stats = live.stats[destination.id], isLive {
                VStack(alignment: .trailing, spacing: 1) {
                    Text("\(stats.kilobitsPerSecond) kbps")
                        .font(.caption.monospacedDigit())
                    if stats.droppedVideoFrames > 0 {
                        Text("\(stats.droppedVideoFrames) dropped")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.orange)
                    }
                }
            }
            if let url = live.watchURLs[destination.id] {
                Link(destination: url) { Image(systemName: "arrow.up.forward.square") }
                    .help("Open the broadcast")
            }
        }
        .padding(10)
        .background(isLive ? Color.red.opacity(0.07) : Color.secondary.opacity(0.06),
                    in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var statusLine: some View {
        if let problem = live.problems[destination.id] {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        } else if let state = live.states[destination.id], isLive || isFailure(state) {
            Text(label(for: state))
                .font(.caption)
                .foregroundStyle(color(for: state))
        } else if let problem = destination.configurationProblem {
            Label(problem, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text("\(destination.tier.displayName)\(destination.platform.commentsUnavailableReason == nil ? " · comments" : "")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func isFailure(_ state: RTMPPublisher.State) -> Bool {
        if case .failed = state { return true }
        return false
    }

    private func label(for state: RTMPPublisher.State) -> String {
        switch state {
        case .idle: "Ready"
        case .connecting: "Connecting…"
        case .live: "Live"
        case .reconnecting(let attempt, let reason): "Reconnecting (try \(attempt)): \(reason)"
        case .failed(let reason): reason
        case .stopped: "Stopped"
        }
    }

    private func color(for state: RTMPPublisher.State) -> Color {
        switch state {
        case .live: .green
        case .connecting, .reconnecting: .orange
        case .failed: .red
        case .idle, .stopped: .secondary
        }
    }
}
