import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel: InboxViewModel
    @StateObject private var progress = ListeningProgressStore.shared
    @State private var showSettings = false
    @State private var showHighlights = false

    init() {
        // Placeholder; replaced in onAppear once we have appState's service.
        _viewModel = StateObject(wrappedValue: InboxViewModel(mailService: MockMailService()))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.emails.isEmpty {
                    ProgressView("Loading inbox…")
                } else if let errorMessage = viewModel.errorMessage, viewModel.emails.isEmpty {
                    InboxStateView(
                        systemImage: "exclamationmark.triangle",
                        title: "Couldn't load your inbox",
                        message: errorMessage,
                        actionTitle: "Try again"
                    ) {
                        Task { await viewModel.load() }
                    }
                } else if viewModel.emails.isEmpty {
                    InboxStateView(
                        systemImage: "tray",
                        title: "Inbox is empty",
                        message: "No messages in this account's inbox.",
                        actionTitle: "Refresh"
                    ) {
                        Task { await viewModel.load() }
                    }
                } else {
                    List(viewModel.emails) { email in
                        NavigationLink {
                            EmailPlayerView(
                                email: email,
                                onMarkedRead: { id in viewModel.markReadLocally(id) },
                                nextUnreadProvider: { id in viewModel.nextUnread(after: id) }
                            )
                        } label: {
                            EmailRow(email: email, progress: progress.progress(for: email.id))
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                Task { await viewModel.markRead(email.id) }
                            } label: {
                                Label("Read", systemImage: "envelope.open")
                            }
                            .tint(.blue)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button {
                                Task { await viewModel.markUnread(email.id) }
                            } label: {
                                Label("Unread", systemImage: "envelope.badge")
                            }
                            .tint(.orange)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await viewModel.load() }
                }
            }
            .navigationTitle("Inbox")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if viewModel.unreadCount > 0 {
                        Text("\(viewModel.unreadCount) unread")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showHighlights = true } label: {
                        Image(systemName: "highlighter")
                    }
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                NavigationStack { SettingsView() }
            }
            .sheet(isPresented: $showHighlights) {
                NavigationStack { HighlightsListView() }
            }
        }
        .task {
            viewModel.configure(appState.mailService)
            if viewModel.emails.isEmpty {
                await viewModel.load()
            }
        }
    }
}

private struct InboxStateView: View {
    let systemImage: String
    let title: String
    let message: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(actionTitle, action: action)
                .buttonStyle(.borderedProminent)
        }
        .padding(40)
    }
}

private struct EmailRow: View {
    let email: Email
    var progress: ListeningProgress? = nil

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(email.isRead ? Color.gray.opacity(0.2) : Color.accentColor.opacity(0.2))
                Text(email.from.initial)
                    .font(.headline)
                    .foregroundStyle(email.isRead ? .secondary : Color.accentColor)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(email.from.displayName)
                        .font(.subheadline)
                        .fontWeight(email.isRead ? .regular : .semibold)
                        .lineLimit(1)
                    Spacer()
                    Text(email.receivedAt, format: .relative(presentation: .numeric))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(email.subjectOrFallback)
                    .font(.subheadline)
                    .fontWeight(email.isRead ? .regular : .medium)
                    .lineLimit(1)
                Text(email.snippet)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                if let progress, progress.fraction > 0 {
                    HStack(spacing: 6) {
                        ProgressView(value: progress.fraction)
                            .frame(maxWidth: 90)
                        Text(progress.isComplete
                             ? "Listened"
                             : "\(Int((progress.fraction * 100).rounded()))% listened")
                            .font(.caption2)
                            .foregroundStyle(progress.isComplete ? Color.green : .secondary)
                    }
                    .padding(.top, 1)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
