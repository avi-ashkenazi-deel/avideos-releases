import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var player: EmailPlayerViewModel
    @StateObject private var viewModel: InboxViewModel
    @StateObject private var progress = ListeningProgressStore.shared
    @StateObject private var readingTimes = ReadingTimeStore.shared
    @State private var showSettings = false
    @State private var showHighlights = false
    @State private var showAnalytics = false
    @State private var searchDebounce: Task<Void, Never>?

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
                    List {
                        ForEach(viewModel.emails) { email in
                            Button {
                                open(email)
                            } label: {
                                EmailRow(
                                    email: email,
                                    readMinutes: readingTimes.minutes(for: email.id),
                                    progress: progress.progress(for: email.id)
                                )
                            }
                            .buttonStyle(.plain)
                            .onAppear {
                                // Infinite scroll: pull the next page near the end.
                                if email.id == viewModel.emails.last?.id {
                                    Task { await viewModel.loadMore() }
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                // Swipe left → mark read (only meaningful when unread).
                                if !email.isRead {
                                    Button {
                                        Task { await viewModel.markRead(email.id) }
                                    } label: {
                                        Label("Read", systemImage: "envelope.open")
                                    }
                                    .tint(.blue)
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                // Swipe right → mark unread / reset (only when read).
                                if email.isRead {
                                    Button {
                                        Task { await viewModel.markUnread(email.id) }
                                    } label: {
                                        Label("Unread", systemImage: "envelope.badge")
                                    }
                                    .tint(.orange)
                                }
                            }
                        }

                        if viewModel.isLoadingMore {
                            HStack { Spacer(); ProgressView(); Spacer() }
                                .listRowSeparator(.hidden)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await viewModel.load() }
                }
            }
            .navigationTitle(viewModel.selectedLabelName)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if viewModel.unreadCount > 0 {
                        Text("\(viewModel.unreadCount) unread")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Menu {
                        ForEach(viewModel.labels) { label in
                            Button {
                                Task { await viewModel.selectLabel(label) }
                            } label: {
                                if label.id == viewModel.selectedLabelId {
                                    Label(label.displayName, systemImage: "checkmark")
                                } else {
                                    Text(label.displayName)
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                    }

                    Button { showAnalytics = true } label: {
                        Image(systemName: "chart.bar")
                    }
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
                    .environmentObject(player)
                    .environmentObject(appState)
            }
            .sheet(isPresented: $showAnalytics) {
                NavigationStack { AnalyticsView() }
            }
            .searchable(text: $viewModel.searchText, prompt: "Search by sender or subject")
            .onChange(of: viewModel.searchText) { _, _ in
                searchDebounce?.cancel()
                searchDebounce = Task {
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    guard !Task.isCancelled else { return }
                    await viewModel.load()
                }
            }
        }
        .task {
            viewModel.configure(appState.mailService)
            if viewModel.emails.isEmpty {
                await viewModel.load()
            }
            await viewModel.loadLabels()
        }
    }

    /// Open the email in the shared player. If a different email is already
    /// playing, this previews it without interrupting; otherwise it loads ready
    /// to play.
    private func open(_ email: Email) {
        player.open(
            email: email,
            isLocal: false,
            onMarkedRead: { [weak viewModel] id in viewModel?.markReadLocally(id) },
            nextUnreadProvider: { [weak viewModel] id in viewModel?.nextUnread(after: id) }
        )
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
    var readMinutes: Int? = nil
    var progress: ListeningProgress? = nil

    var body: some View {
        HStack(spacing: 12) {
            // Sender thumbnail with a listening-progress ring around it.
            SenderAvatar(email: email, progress: progress)

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
                    .lineLimit(2)

                if let readMinutes {
                    HStack(spacing: 4) {
                        Image(systemName: "clock").font(.caption2)
                        Text("\(readMinutes) min read").font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.top, 1)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
