import SwiftUI

/// A toolbar button that opens the saved Highlights list. Lives on every tab's
/// top-right, since highlights can be captured from the inbox, saved articles,
/// or feeds.
struct HighlightsToolbarButton: View {
    @EnvironmentObject private var player: EmailPlayerViewModel
    @EnvironmentObject private var appState: AppState
    @State private var showHighlights = false

    var body: some View {
        Button { showHighlights = true } label: {
            Image(systemName: "bookmark")
        }
        .accessibilityLabel("Highlights")
        .sheet(isPresented: $showHighlights) {
            NavigationStack { HighlightsListView() }
                .environmentObject(player)
                .environmentObject(appState)
        }
    }
}
