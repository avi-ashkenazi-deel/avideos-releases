import SwiftUI

/// iPhone inbox tab: the inbox list wrapped in its own `NavigationStack`.
struct InboxView: View {
    var body: some View {
        NavigationStack { InboxList() }
    }
}

/// The inbox list plus its toolbar, search, and sheets — but **no**
/// `NavigationStack` of its own, so it can be hosted two ways: wrapped by
/// `InboxView` as the iPhone tab, and dropped into the iPad split view's sidebar
/// column (where the split view supplies the navigation context).
struct InboxList: View {
    /// Whether to show the Analytics/Highlights/Settings buttons in the trailing
    /// toolbar. True on iPhone (this list owns them); false on iPad, where the
    /// split view's source sidebar provides them instead, so they aren't doubled.
    var showsUtilityToolbar: Bool

    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var player: EmailPlayerViewModel
    @StateObject private var viewModel: InboxViewModel
    @StateObject private var progress = ListeningProgressStore.shared
    @StateObject private var readingTimes = ReadingTimeStore.shared
    @State private var showSettings = false
    @State private var searchDebounce: Task<Void, Never>?

    init(showsUtilityToolbar: Bool = true) {
        self.showsUtilityToolbar = showsUtilityToolbar
        // Placeholder; replaced in onAppear once we have appState's service.
        _viewModel = StateObject(wrappedValue: InboxViewModel(mailService: MockMailService()))
    }

    /// Folder name with the unread count appended, e.g. "Inbox (44)".
    private var titleText: String {
        viewModel.unreadCount > 0
            ? "\(viewModel.selectedLabelName) (\(viewModel.unreadCount))"
            : viewModel.selectedLabelName
    }

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.emails.isEmpty {
                ProgressView("Loading inbox…")
            } else if viewModel.needsReauth {
                InboxStateView(
                    systemImage: "person.crop.circle.badge.exclamationmark",
                    title: "Reconnect your account",
                    message: "Your \(appState.account?.emailAddress ?? "email") sign-in expired. Reconnect to keep syncing — your notes, saved links, and progress are safe and won't be touched.",
                    actionTitle: "Reconnect"
                ) {
                    Task {
                        await appState.reconnectActiveAccount()
                        await viewModel.load()
                    }
                }
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
                        .buttonStyle(RowPressStyle())
                        .listRowSeparator(.hidden)
                        // Highlight the email that's currently loaded in the player,
                        // so it's obvious in the list which one is playing.
                        .listRowBackground(
                            email.id == player.parsed?.email.id
                                ? Color.accentColor.opacity(0.12)
                                : Color.clear
                        )
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                // Tap the title to switch folder/category. (This used to be a
                // toolbar funnel icon that got dropped when the bar was crowded.)
                if viewModel.labels.count > 1 {
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
                        HStack(spacing: 4) {
                            Text(titleText).font(.headline)
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(.primary)
                    }
                } else {
                    Text(titleText).font(.headline)
                }
            }
            if showsUtilityToolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // Highlights (bookmark) leftmost — the control every screen shares.
                    HighlightsToolbarButton()
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack { SettingsView() }
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
        .task(id: appState.activeAccountID) {
            // Re-runs whenever the active account changes, so switching accounts
            // rebinds to the new mailbox and reloads its inbox + folders.
            viewModel.configure(appState.mailService)
            await viewModel.load()
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
        .frame(maxWidth: .infinity, alignment: .leading)
        // Make the whole row tappable, not just where the text sits.
        .contentShape(Rectangle())
    }
}
