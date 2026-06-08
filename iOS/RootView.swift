import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    // The single, app-wide player. Lives here so playback survives navigating
    // between tabs and emails; the mini-player, Now Playing view, and the iPad
    // detail pane all drive it.
    @StateObject private var player = EmailPlayerViewModel(mailService: MockMailService())
    @AppStorage("hasCompletedWelcome") private var hasCompletedWelcome = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        switch appState.phase {
        case .onboarding:
            if hasCompletedWelcome {
                OnboardingView()
            } else {
                WelcomeView { hasCompletedWelcome = true }
            }
        case .ready:
            readyLayout
                .environmentObject(player)
                .task(id: appState.activeAccountID) {
                    // Rebind the player to the active account's mailbox on switch.
                    player.configure(appState.mailService)
                    player.bindRemoteCommands()
                }
        }
    }

    /// iPad (regular width) gets a two-column split — the email list on the left,
    /// the reading view + player permanently on the right. iPhone (compact) keeps
    /// the tab bar, floating mini-player, and full-screen Now Playing.
    @ViewBuilder
    private var readyLayout: some View {
        if horizontalSizeClass == .regular {
            SplitLayout()
        } else {
            CompactLayout()
        }
    }
}

/// iPhone layout: Inbox/Saved tabs with a floating mini-player that expands into
/// the full-screen Now Playing view.
private struct CompactLayout: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var player: EmailPlayerViewModel

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView {
                InboxView()
                    .tabItem { Label("Inbox", systemImage: "tray.full") }

                SavedArticlesView()
                    .tabItem { Label("Saved", systemImage: "bookmark") }
            }

            if player.parsed != nil {
                MiniPlayerBar()
                    // Float just above the standard tab bar (≈49pt) with a gap.
                    .padding(.bottom, 53)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: player.parsed != nil)
        .fullScreenCover(isPresented: $player.isExpanded) {
            NowPlayingView()
                .environmentObject(player)
                .environmentObject(appState)
        }
    }
}

/// The two libraries the iPad source sidebar switches between.
private enum LibrarySection: Hashable { case inbox, saved }

/// iPad layout: a three-column split view, like Mail. A narrow source sidebar
/// (Inbox / Saved) on the far left, the selected list in the middle, and the
/// reading view + player permanently on the right — so there's no mini-player or
/// full-screen cover; the email or article you tap simply appears on the right.
private struct SplitLayout: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var player: EmailPlayerViewModel
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var section: LibrarySection? = .inbox
    @State private var showSettings = false
    @State private var showHighlights = false
    @State private var showAnalytics = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            // Source sidebar + the utility actions that are toolbar buttons on the
            // iPhone inbox (they'd be duplicated if left on the middle list too).
            List(selection: $section) {
                Label("Inbox", systemImage: "tray.full").tag(LibrarySection.inbox)
                Label("Saved", systemImage: "bookmark").tag(LibrarySection.saved)
            }
            .navigationTitle("VoiceInbox")
            .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 300)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showAnalytics = true } label: { Image(systemName: "chart.bar") }
                    Button { showHighlights = true } label: { Image(systemName: "highlighter") }
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
        } content: {
            switch section ?? .inbox {
            case .inbox: InboxList(showsUtilityToolbar: false)
            case .saved: SavedArticlesList()
            }
        } detail: {
            NavigationStack {
                if player.parsed != nil || player.staged != nil {
                    PlayerDetailContent()
                } else {
                    ContentUnavailableView(
                        "No email selected",
                        systemImage: "envelope.open",
                        description: Text("Pick a message on the left to read and listen along.")
                    )
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
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
    }
}
