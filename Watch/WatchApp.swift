import SwiftUI

@main
struct VoiceInboxWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchInboxView()
                .task { WatchConnectivityBridge.shared.activate() }
        }
    }
}
