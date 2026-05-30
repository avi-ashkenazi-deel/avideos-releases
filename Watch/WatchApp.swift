import SwiftUI

@main
struct VoiceInboxWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchInboxView()
                .task {
                    WatchConnectivityBridge.shared.onElevenLabsConfig = { key, voiceID, enabled in
                        let settings = AppSettings.shared
                        settings.elevenLabsAPIKey = key
                        settings.elevenLabsVoiceID = voiceID
                        settings.useElevenLabs = enabled
                    }
                    WatchConnectivityBridge.shared.activate()
                }
        }
    }
}
