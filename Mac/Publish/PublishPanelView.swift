import SwiftUI
import AppKit
import Observation

/// The publishing surface: queue on top, metadata form for the next upload
/// below, connection status at the bottom.
///
/// Intended call site — a sheet from the edit workspace once an export has
/// finished, seeded with the rendered file and (if generated) the project's
/// YouTube chapter list:
///
///     .sheet(isPresented: $showingPublish) {
///         PublishPanelView(queue: publishQueue,
///                          initialFileURL: lastExportURL,
///                          chaptersText: ChapterGenerator.youtubeText(chapters: project.chapters),
///                          onClose: { showingPublish = false })
///     }
///
/// Export-to-disk works with none of this configured; publishing is additive.
struct PublishPanelView: View {
    var queue: PublishQueue
    let initialFileURL: URL?
    let chaptersText: String?
    let onClose: () -> Void

    @State private var fileURL: URL?
    @State private var platform: PublishPlatform = .youtube
    @State private var title = ""
    @State private var descriptionText = ""
    @State private var tagText = ""
    @State private var scheduleEnabled = false
    @State private var scheduledAt = Date().addingTimeInterval(3600)
    @State private var authRefresh = 0

    var body: some View {
        VStack(spacing: 0) {
            queueSection
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    fileSection
                    PublishMetadataEditor(platform: $platform,
                                          title: $title,
                                          descriptionText: $descriptionText,
                                          tagText: $tagText,
                                          scheduleEnabled: $scheduleEnabled,
                                          scheduledAt: $scheduledAt,
                                          chaptersText: chaptersText,
                                          isAuthorized: queue.auth.isAuthorized(platform))
                    Divider()
                    PlatformAuthView(auth: queue.auth, refreshToken: authRefresh)
                }
                .padding(12)
            }
            Divider()
            footer
        }
        .frame(minWidth: 560, minHeight: 620)
        .onAppear {
            fileURL = initialFileURL
            if title.isEmpty {
                title = initialFileURL?.deletingPathExtension().lastPathComponent ?? ""
            }
        }
    }

    // MARK: - Queue

    private var queueSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Publish Queue").font(.headline)
            if queue.items.isEmpty {
                Text("Nothing queued.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
            } else {
                List(queue.items) { item in
                    queueRow(item)
                }
                .listStyle(.inset)
                .frame(minHeight: 140, maxHeight: 200)
            }
        }
        .padding(12)
    }

    private func queueRow(_ item: PublishItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.platform.displayName)
                        .font(.caption.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                    Text(item.title).lineLimit(1)
                }
                statusLine(item)
            }
            Spacer()
            actions(for: item)
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private func statusLine(_ item: PublishItem) -> some View {
        switch item.status {
        case .queued:
            Text("Queued").font(.caption).foregroundStyle(.secondary)
        case .scheduled(let date):
            Text("Scheduled for \(date.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .uploading(let progress):
            ProgressView(value: progress)
                .frame(maxWidth: 220)
        case .published(let remoteURL):
            HStack(spacing: 6) {
                Label("Published", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
                if let remoteURL, let url = URL(string: remoteURL) {
                    Link("Open", destination: url).font(.caption)
                }
            }
        case .failed(let message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .lineLimit(3)
        }
    }

    @ViewBuilder
    private func actions(for item: PublishItem) -> some View {
        HStack(spacing: 10) {
            switch item.status {
            case .failed:
                Button("Retry") { Task { await queue.publish(itemID: item.id) } }
            case .scheduled:
                Button("Publish Now") { Task { await queue.publish(itemID: item.id) } }
            case .queued, .uploading, .published:
                EmptyView()
            }
            Button("Remove") { queue.remove(id: item.id) }
        }
        .buttonStyle(.link)
        .font(.caption)
    }

    // MARK: - File

    private var fileSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Video File").font(.headline)
            HStack {
                Text(fileURL?.lastPathComponent ?? "No file chosen")
                    .font(.callout)
                    .foregroundStyle(fileURL == nil ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Button("Choose…") { chooseFile() }
            }
        }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        fileURL = url
        if title.isEmpty {
            title = url.deletingPathExtension().lastPathComponent
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Spacer()
            Button("Close") { onClose() }
            Button(scheduleEnabled ? "Schedule" : "Publish") { enqueue() }
                .keyboardShortcut(.defaultAction)
                .disabled(fileURL == nil || title.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(12)
    }

    private func enqueue() {
        guard let fileURL else { return }
        let tags = tagText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let item = PublishItem(platform: platform,
                               fileURL: fileURL,
                               title: title.trimmingCharacters(in: .whitespaces),
                               descriptionText: descriptionText,
                               tags: tags,
                               scheduledAt: scheduleEnabled ? scheduledAt : nil)
        queue.enqueue(item)
        authRefresh += 1
    }
}
