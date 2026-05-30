import SwiftUI

@main
struct VoiceInboxApp: App {
    @StateObject private var appState = AppState()

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
                }
        }
    }
}
