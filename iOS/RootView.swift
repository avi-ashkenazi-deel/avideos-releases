import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.phase {
        case .onboarding:
            OnboardingView()
        case .ready:
            TabView {
                InboxView()
                    .tabItem { Label("Inbox", systemImage: "tray.full") }

                SavedArticlesView()
                    .tabItem { Label("Saved", systemImage: "bookmark") }
            }
        }
    }
}
