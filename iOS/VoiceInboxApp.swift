import SwiftUI
import BackgroundTasks
import UserNotifications

/// Handles taps on notifications. A feed notification carries the newest item's
/// id; tapping it routes the app to open that item directly.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()

    // Show feed notifications even while the app is foregrounded.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let id = info["feedItemID"] as? String, !id.isEmpty else { return }
        await MainActor.run { NotificationRouter.shared.openFeedItemID = id }
    }
}

@main
struct VoiceInboxApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    /// Matches `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
    private static let feedRefreshTaskID = "com.aviashkenazi.voiceinbox.feedrefresh"

    init() {
        Self.registerFeedRefreshTask()
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .task {
                    await appState.bootstrap()
                    // Let the feed store kick off a background-refresh schedule as
                    // soon as the user turns on notifications for a feed.
                    FeedStore.shared.onRequestBackgroundRefresh = { Self.scheduleFeedRefresh() }
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
        // We ask for ~15 min; iOS treats this as the *earliest* it'll consider us
        // and decides the real cadence from how the app is used, battery, etc.
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
