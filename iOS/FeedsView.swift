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
    @EnvironmentObject private var player: EmailPlayerViewModel
    @StateObject private var store = FeedStore.shared
    @State private var searchText = ""
    @State private var showAddFeed = false
    @State private var showManage = false

    private var shownItems: [RSSItem] {
        store.search(searchText)
    }

    var body: some View {
        Group {
            if store.feeds.isEmpty {
                emptyState
            } else if shownItems.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No articles yet" : "No matches",
                    systemImage: searchText.isEmpty ? "dot.radiowaves.up.forward" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Pull to refresh your feeds."
                        : "No articles match “\(searchText)” across your feeds.")
                )
            } else {
                List {
                    ForEach(shownItems) { item in
                        Button { open(item) } label: {
                            FeedItemRow(item: item, feedTitle: store.feed(for: item.feedID)?.title ?? "")
                        }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .swipeActions(edge: .leading) {
                            Button {
                                store.markRead(item.id, read: !item.isRead)
                            } label: {
                                Label(item.isRead ? "Unread" : "Read",
                                      systemImage: item.isRead ? "circle" : "checkmark.circle")
                            }
                            .tint(.blue)
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Feeds")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if store.isRefreshing { ProgressView() }
                Button { showAddFeed = true } label: { Image(systemName: "plus") }
                Button { showManage = true } label: { Image(systemName: "slider.horizontal.3") }
            }
        }
        .searchable(text: $searchText, prompt: "Search across all feeds")
        .refreshable { await store.refreshAll() }
        .sheet(isPresented: $showAddFeed) {
            NavigationStack { AddFeedView() }
        }
        .sheet(isPresented: $showManage) {
            NavigationStack { ManageFeedsView() }
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

    /// Read the item: prefer the feed-supplied full content; otherwise fetch the
    /// article page and extract it (falls back to the summary offline).
    private func open(_ item: RSSItem) {
        let feedTitle = store.feed(for: item.feedID)?.title ?? "Feed"
        store.markRead(item.id)

        // Enough inline content → play immediately.
        if let html = item.contentHTML, html.count > 400 {
            player.open(email: item.makeEmail(feedTitle: feedTitle), isLocal: true)
            return
        }
        // Try the full article; fall back to whatever the feed gave us.
        if let link = item.link {
            Task {
                let full = try? await ArticleExtractor.fetch(link)
                player.open(email: item.makeEmail(feedTitle: feedTitle, fullHTML: full?.html),
                            isLocal: true)
            }
        } else {
            player.open(email: item.makeEmail(feedTitle: feedTitle), isLocal: true)
        }
    }
}

private struct FeedItemRow: View {
    let item: RSSItem
    let feedTitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
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
            if let summary = item.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
    @State private var adding = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("Feed URL (e.g. stratechery.com/feed)", text: $urlText)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                Text("Paste the site's RSS/Atom feed URL. Most blogs and newsletters expose one (often at /feed or /rss).")
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
    }

    private func add() {
        adding = true
        error = nil
        Task {
            do {
                try await store.add(urlString: urlText)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            adding = false
        }
    }
}

// MARK: - Manage feeds (per-feed notifications, unfollow)

private struct ManageFeedsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = FeedStore.shared

    var body: some View {
        List {
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
    }
}
