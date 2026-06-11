import SwiftUI
import BackgroundTasks

@main
struct VoiceInboxApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    /// Matches `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
    private static let feedRefreshTaskID = "com.aviashkenazi.voiceinbox.feedrefresh"

    init() {
        Self.registerFeedRefreshTask()
    }

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
            switch phase {
            case .active:
                // Pick up and fetch articles shared via the Share Extension.
                Task { await SavedArticleStore.shared.refresh() }
            case .background:
                // Ask iOS to wake us later to refresh feeds (and notify).
                Self.scheduleFeedRefresh()
            default:
                break
            }
        }
    }

    // MARK: - Background feed refresh (new-article notifications)

    private static func registerFeedRefreshTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: feedRefreshTaskID, using: nil) { task in
            scheduleFeedRefresh()   // keep the chain going for next time
            let work = Task { @MainActor in
                await FeedStore.shared.refreshAll(notify: true)
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    private static func scheduleFeedRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: feedRefreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)   // ≥ 30 min out
        try? BGTaskScheduler.shared.submit(request)
    }
}
