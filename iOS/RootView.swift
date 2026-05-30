import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.phase {
        case .onboarding:
            OnboardingView()
        case .ready:
            InboxView()
        }
    }
}
