import SwiftUI

/// The session library: recorded podcast sessions → takes → per-participant
/// tracks with live status, download/import pipeline, and "Open in Editor".
struct SessionLibraryView: View {
    @Environment(StudioController.self) private var studio
    @State private var selectedSessionID: String?
    @State private var isProcessing = false

    private var library: SessionLibraryStore { studio.sessionLibrary }

    var body: some View {
        HSplitView {
            sessionList
                .frame(minWidth: 220, maxWidth: 300)
            detail
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var sessionList: some View {
        List(selection: $selectedSessionID) {
            Section("Sessions") {
                ForEach(library.sessions) { session in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.createdAt.formatted(date: .abbreviated, time: .shortened))
                            .fontWeight(.medium)
                        Text("\(session.participants.count) participants · \(session.takes.count) takes")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(session.id)
                    .contextMenu {
                        Button("Delete Session", role: .destructive) {
                            library.deleteSession(id: session.id)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let session = library.sessions.first(where: { $0.id == selectedSessionID }) {
            sessionDetail(session)
        } else {
            ContentUnavailableView("Select a session",
                                   systemImage: "waveform",
                                   description: Text("Podcast-mode recordings appear here after a show."))
        }
    }

    private func sessionDetail(_ session: RecordingSession) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Session \(session.id)").font(.title3.bold())
                    Text(ByteCountFormatter.string(fromByteCount: library.storageBytes(sessionId: session.id),
                                                   countStyle: .file))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    downloadAndImport(session)
                } label: {
                    if isProcessing {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Download & Import All", systemImage: "arrow.down.circle")
                    }
                }
                .disabled(isProcessing)

                Button {
                    openInEditor(session)
                } label: {
                    Label("Open in Editor", systemImage: "scissors")
                }
                .disabled(library.importedTracks(sessionId: session.id).isEmpty)
            }

            List {
                ForEach(session.takes) { take in
                    Section("Take \(take.id)") {
                        ForEach(Array(take.tracks.enumerated()), id: \.offset) { _, track in
                            trackRow(track, take: take, session: session)
                        }
                    }
                }
            }
        }
        .padding()
    }

    private func trackRow(_ track: TrackRecord, take: TakeRecord, session: RecordingSession) -> some View {
        let key = SessionLibraryStore.TrackKey(takeId: take.id,
                                               participantId: track.participantId,
                                               kind: track.kind)
        let status = library.trackStatus[key]
        let name = session.participants.first { $0.id == track.participantId }?.displayName
            ?? track.participantId

        return HStack {
            Image(systemName: track.kind == .video ? "video" : "waveform")
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(name) — \(track.kind.rawValue)")
                if let width = track.width, let height = track.height {
                    Text("\(width)×\(height)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            switch status {
            case .downloading(let fraction), .uploading(let fraction):
                ProgressView(value: fraction).frame(width: 90)
            case .importing:
                ProgressView().controlSize(.small)
            default:
                EmptyView()
            }
            Text(status?.displayText ?? (track.finalized ? "Ready to download" : "Waiting for upload"))
                .font(.caption)
                .foregroundStyle(statusColor(status))
        }
    }

    private func statusColor(_ status: SessionLibraryStore.TrackStatus?) -> Color {
        switch status {
        case .imported: .green
        case .failed: .red
        default: .secondary
        }
    }

    private func downloadAndImport(_ session: RecordingSession) {
        guard let baseURL = studio.workerBaseURL,
              let api = try? PodcastAPIClient(baseURL: baseURL) else { return }
        isProcessing = true
        Task {
            _ = await library.downloadAndImportAll(session: session, api: api)
            isProcessing = false
        }
    }

    private func openInEditor(_ session: RecordingSession) {
        let tracks = library.importedTracks(sessionId: session.id)
        guard !tracks.isEmpty else { return }
        studio.openEditor(tracks: tracks, sessionId: session.id)
    }
}
