import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    // The single, app-wide player. Lives here so playback survives navigating
    // between tabs and emails; the mini-player and Now Playing view both drive it.
    @StateObject private var player = EmailPlayerViewModel(mailService: MockMailService())
    @AppStorage("hasCompletedWelcome") private var hasCompletedWelcome = false

    var body: some View {
        switch appState.phase {
        case .onboarding:
            if hasCompletedWelcome {
                OnboardingView()
            } else {
                WelcomeView { hasCompletedWelcome = true }
            }
        case .ready:
            ZStack(alignment: .bottom) {
                TabView {
                    InboxView()
                        .tabItem { Label("Inbox", systemImage: "tray.full") }

                    SavedArticlesView()
                        .tabItem { Label("Saved", systemImage: "bookmark") }
                }
                .environmentObject(player)

                if player.parsed != nil {
                    MiniPlayerBar()
                        .environmentObject(player)
                        // Float just above the standard tab bar (≈49pt) with a gap.
                        .padding(.bottom, 53)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: player.parsed != nil)
            .task {
                player.configure(appState.mailService)
                player.bindRemoteCommands()
            }
            .fullScreenCover(isPresented: $player.isExpanded) {
                NowPlayingView()
                    .environmentObject(player)
                    .environmentObject(appState)
            }
        }
    }
}
