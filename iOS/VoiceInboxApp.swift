import SwiftUI

@main
struct VoiceInboxApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .task {
                    await appState.bootstrap()
                    // Save highlights captured on the watch into the shared store.
                    WatchConnectivityBridge.shared.onHighlight = { highlight in
                        HighlightStore.shared.add(highlight)
                    }
                    WatchConnectivityBridge.shared.activate()
                    let s = appState.settings
                    WatchConnectivityBridge.shared.syncElevenLabsConfig(
                        key: s.elevenLabsAPIKey,
                        voiceID: s.elevenLabsVoiceID,
                        enabled: s.useElevenLabs
                    )
                    // Process anything shared into the app while we were closed.
                    await SavedArticleStore.shared.refresh()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // Pick up and fetch articles shared via the Share Extension.
            if phase == .active {
                Task { await SavedArticleStore.shared.refresh() }
            }
        }
    }
}
