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

/// iPad layout: a two-column split view. The inbox list is the sidebar; the
/// reading view + player live permanently in the detail column, so there's no
/// mini-player or full-screen cover — the email you tap simply appears on the
/// right. Saved articles (a tab on iPhone) are reached from the list's toolbar.
private struct SplitLayout: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var player: EmailPlayerViewModel
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var showSaved = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            InboxList(onShowSaved: { showSaved = true })
                .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 460)
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
        .sheet(isPresented: $showSaved) {
            SavedArticlesView()
                .environmentObject(player)
                .environmentObject(appState)
        }
    }
}
