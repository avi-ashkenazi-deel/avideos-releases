import SwiftUI

/// iPhone Feeds tab: the feeds list wrapped in its own `NavigationStack`.
struct FeedsView: View {
    var body: some View {
        NavigationStack { FeedsList() }
    }
}

/// RSS feeds (a lightweight Feedly): an aggregated, searchable timeline across
/// every followed feed, with add/manage and per-feed notifications. No
/// `NavigationStack` of its own so it can also be the iPad content column.
struct FeedsList: View {
    /// Hidden on iPad, where the split view's column provides Highlights.
    var showsHighlightsButton: Bool = true

    @EnvironmentObject private var player: EmailPlayerViewModel
    @StateObject private var store = FeedStore.shared
    @StateObject private var progress = ListeningProgressStore.shared
    @Environment(\.openURL) private var openURL
    @State private var searchText = ""
    @State private var showAddFeed = false
    /// nil = all feeds; otherwise filter to one feed (tap the title to switch).
    @State private var selectedFeedID: String?

    private var shownItems: [RSSItem] {
        let base = store.search(searchText)
        guard let id = selectedFeedID, store.feeds.contains(where: { $0.id == id }) else { return base }
        return base.filter { $0.feedID == id }
    }

    private var currentFilterName: String {
        guard let id = selectedFeedID else { return "Feeds" }
        return store.feed(for: id)?.title ?? "Feeds"
    }

    var body: some View {
        Group {
            if store.feeds.isEmpty {
                emptyState
            } else if shownItems.isEmpty {
                // Wrapped in a ScrollView so pull-to-refresh actually works here —
                // .refreshable only hooks onto a scrollable container, and this is
                // the screen that tells you to pull. containerRelativeFrame keeps
                // the message centred in the viewport.
                ScrollView {
                    ContentUnavailableView(
                        searchText.isEmpty ? "No articles yet" : "No matches",
                        systemImage: searchText.isEmpty ? "dot.radiowaves.up.forward" : "magnifyingglass",
                        description: Text(searchText.isEmpty
                            ? "Pull to refresh your feeds."
                            : "No articles match “\(searchText)” across your feeds.")
                    )
                    .containerRelativeFrame([.horizontal, .vertical])
                }
            } else {
                List {
                    ForEach(shownItems) { item in
                        Button { open(item) } label: {
                            FeedItemRow(item: item,
                                        feedTitle: store.feed(for: item.feedID)?.title ?? "",
                                        progress: progress.progress(for: "rss-\(item.id)"))
                        }
                        .buttonStyle(RowPressStyle())
                        .listRowSeparator(.hidden)
                        // Highlight the article currently loaded in the player.
                        .listRowBackground(
                            player.parsed?.email.id == "rss-\(item.id)"
                                ? Color.accentColor.opacity(0.12)
                                : Color.clear
                        )
                        .swipeActions(edge: .leading) {
                            Button {
                                store.markRead(item.id, read: !item.isRead)
                            } label: {
                                Label(item.isRead ? "Unread" : "Read",
                                      systemImage: item.isRead ? "circle" : "checkmark.circle")
                            }
                            .tint(.blue)
                        }
                        .swipeActions(edge: .trailing) {
                            Button {
                                store.markRead(item.id, read: !item.isRead)
                            } label: {
                                Label(item.isRead ? "Unread" : "Read",
                                      systemImage: item.isRead ? "envelope.badge" : "checkmark.circle")
                            }
                            .tint(item.isRead ? .orange : .blue)

                            if let link = item.link {
                                Button {
                                    openURL(link)
                                } label: {
                                    Label("Open", systemImage: "safari")
                                }
                                .tint(.gray)
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Left-aligned title that doubles as a feed filter when you follow
            // more than one — tap to jump between All Feeds and a single feed.
            ToolbarItem(placement: .topBarLeading) {
                if store.feeds.count > 1 {
                    Menu {
                        Button { selectedFeedID = nil } label: { filterLabel("All Feeds", selected: selectedFeedID == nil) }
                        ForEach(store.feeds) { feed in
                            Button { selectedFeedID = feed.id } label: {
                                filterLabel(feed.title, selected: selectedFeedID == feed.id)
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(currentFilterName).font(.headline)
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(.primary)
                    }
                } else {
                    Text("Feeds").font(.headline)
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if store.isRefreshing { ProgressView() }
                // Highlights (bookmark) leftmost — shared across every screen.
                if showsHighlightsButton { HighlightsToolbarButton() }
                Button { showAddFeed = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add a feed")
            }
        }
        .searchable(text: $searchText, prompt: "Search across all feeds")
        .refreshable { await store.refreshAll() }
        .sheet(isPresented: $showAddFeed) {
            NavigationStack { AddFeedView() }
        }
        .task {
            // Refresh on first show; cheap if there are no feeds.
            await store.refreshAll()
        }
        .alert("Feed problem", isPresented: .constant(store.errorMessage != nil)) {
            Button("OK") { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "dot.radiowaves.up.forward")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("No feeds yet").font(.headline)
            Text("Follow your favorite sites' RSS feeds and listen to new articles — like Feedly, but read aloud.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button { showAddFeed = true } label: {
                Label("Add a feed", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(40)
    }

    @ViewBuilder
    private func filterLabel(_ name: String, selected: Bool) -> some View {
        if selected { Label(name, systemImage: "checkmark") } else { Text(name) }
    }

    /// Read the item: prefer the feed-supplied full content; otherwise fetch the
    /// article page and extract it (falls back to the summary offline). Marks read
    /// when it finishes playing (mirroring emails), not merely on open.
    private func open(_ item: RSSItem) {
        FeedPlayback.open(item, player: player, store: store)
    }
}

private struct FeedItemRow: View {
    let item: RSSItem
    let feedTitle: String
    var progress: ListeningProgress?

    var body: some View {
        HStack(spacing: 12) {
            // Same avatar + progress ring as the inbox so the two lists match in
            // size and style; the avatar resolves the source site's icon.
            SenderAvatar(email: item.makeEmail(feedTitle: feedTitle), progress: progress)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(feedTitle.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Text(item.publishedAt, format: .relative(presentation: .numeric))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(item.title)
                    .font(.subheadline)
                    .fontWeight(item.isRead ? .regular : .semibold)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

// MARK: - Add feed

private struct AddFeedView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = FeedStore.shared
    @State private var urlText = ""
    @State private var notify = false
    @State private var adding = false
    @State private var error: String?

    /// Show the one-time notifications pitch on the user's first-ever feed add.
    @State private var showPitch = !FeedStore.shared.hasSeenNotificationsPitch

    var body: some View {
        Form {
            if showPitch {
                Section {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "bell.badge.fill")
                            .font(.title2)
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Never miss a new article")
                                .font(.subheadline.weight(.semibold))
                            Text("Turn on the bell and we'll check this feed in the background — about every 15 minutes — and notify you when something new lands.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }

            Section {
                TextField("Site or feed URL (e.g. stratechery.com)", text: $urlText)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                Text("Paste a site address or a direct RSS/Atom URL — the app finds the feed automatically.")
            }

            Section {
                Toggle(isOn: $notify) {
                    Label("Notify me about new articles", systemImage: "bell")
                }
            } footer: {
                Text("Only feeds with the bell on can send notifications. You can change this any time in Manage feeds.")
            }

            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Add feed")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                if adding {
                    ProgressView()
                } else {
                    Button("Add") { add() }
                        .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .alert("Notifications are off", isPresented: $store.notificationsDenied) {
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("You followed this feed with the bell on, but notifications are turned off for VoiceInbox. Enable them in Settings to get new-article alerts.")
        }
    }

    private func add() {
        adding = true
        error = nil
        Task {
            do {
                let id = try await store.add(urlString: urlText)
                if notify { store.setNotifications(true, for: id) }
                store.markNotificationsPitchSeen()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            adding = false
        }
    }
}

// MARK: - Manage feeds (per-feed notifications, unfollow)

struct ManageFeedsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = FeedStore.shared

    var body: some View {
        List {
            if store.unreadCount > 0 {
                Section {
                    Button { store.markAllRead() } label: {
                        Label("Mark all as read", systemImage: "checkmark.circle")
                    }
                }
            }
            ForEach(store.feeds) { feed in
                VStack(alignment: .leading, spacing: 6) {
                    Text(feed.title).font(.subheadline.weight(.semibold))
                    if let host = feed.siteURL?.host ?? feed.url.host {
                        Text(host).font(.caption).foregroundStyle(.secondary)
                    }
                    Toggle("Notify on new articles", isOn: Binding(
                        get: { feed.notifyOnNewItems },
                        set: { store.setNotifications($0, for: feed.id) }
                    ))
                    .font(.caption)
                }
                .padding(.vertical, 2)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) { store.remove(feed.id) } label: {
                        Label("Unfollow", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle("Manage feeds")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .overlay {
            if store.feeds.isEmpty {
                ContentUnavailableView("No feeds", systemImage: "dot.radiowaves.up.forward")
            }
        }
        .alert("Notifications are off", isPresented: $store.notificationsDenied) {
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("Notifications are turned off for VoiceInbox. Enable them in Settings to get new-article alerts.")
        }
    }
}
