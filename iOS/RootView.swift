import SwiftUI
import Combine

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    // The single, app-wide player. Lives here so playback survives navigating
    // between tabs and emails; the mini-player, Now Playing view, and the iPad
    // detail pane all drive it.
    @StateObject private var player = EmailPlayerViewModel(mailService: MockMailService())
    @ObservedObject private var settings = AppSettings.shared
    @AppStorage("hasCompletedWelcome") private var hasCompletedWelcome = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        switch appState.phase {
        case .launching:
            SplashView()
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
                // Keep the Apple Watch remote in sync: push a snapshot whenever
                // playback state changes, and re-push when the watch reconnects.
                .onAppear { connectWatchRemote() }
                .onChange(of: player.isPlaying) { _, _ in pushNowPlaying() }
                .onChange(of: player.currentBlockIndex) { _, _ in pushNowPlaying() }
                .onChange(of: player.parsed?.email.id) { _, _ in pushNowPlaying() }
                .onChange(of: settings.speed) { _, _ in pushNowPlaying() }
                .onReceive(WatchConnectivityBridge.shared.$isReachable) { reachable in
                    if reachable { pushNowPlaying() }
                }
        }
    }

    /// Wire the watch as a remote: run its transport commands against the shared
    /// player, and apply speed changes it sends.
    private func connectWatchRemote() {
        let bridge = WatchConnectivityBridge.shared
        bridge.onCommand = { command in
            switch command {
            case .play:             if !player.isPlaying { player.togglePlayPause() }
            case .pause:            if player.isPlaying { player.togglePlayPause() }
            case .nextSentence:     player.nextSentence()
            case .previousSentence: player.previousSentence()
            case .highlight:        _ = player.captureHighlight()
            }
        }
        bridge.onSpeed = { newValue in AppSettings.shared.speed = newValue }
        pushNowPlaying()
    }

    /// Send the current player snapshot to the watch remote.
    private func pushNowPlaying() {
        let state: NowPlayingState
        if let email = player.parsed?.email {
            state = NowPlayingState(
                sender: email.from.displayName,
                subject: email.subjectOrFallback,
                senderAddress: email.from.address,
                isPlaying: player.isPlaying,
                progress: player.progress,
                secondsRemaining: Int((player.duration * (1 - player.progress)).rounded()),
                speed: settings.speed
            )
        } else {
            state = .empty
        }
        WatchConnectivityBridge.shared.send(nowPlaying: state)
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
            // Source sidebar. (Utility actions live on the middle column's toolbar,
            // which is always visible — the sidebar collapses in portrait.)
            List(selection: $section) {
                Label("Inbox", systemImage: "tray.full").tag(LibrarySection.inbox)
                Label("Saved", systemImage: "bookmark").tag(LibrarySection.saved)
            }
            .navigationTitle("VoiceInbox")
            .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 300)
        } content: {
            Group {
                switch section ?? .inbox {
                case .inbox: InboxList(showsUtilityToolbar: false)
                case .saved: SavedArticlesList()
                }
            }
            // Analytics / Highlights / Settings — on the always-visible list column
            // so they're reachable in portrait too (the sidebar hides there).
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showAnalytics = true } label: { Image(systemName: "chart.bar") }
                    Button { showHighlights = true } label: { Image(systemName: "highlighter") }
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
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
