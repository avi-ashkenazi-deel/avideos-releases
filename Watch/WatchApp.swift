import SwiftUI

@main
struct VoiceInboxWatchApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                WatchNowPlayingView()
            }
            .task {
                // Activate the link to the phone; the bridge then receives the
                // phone's now-playing snapshots and relays transport commands back.
                WatchConnectivityBridge.shared.activate()
            }
        }
    }
}
