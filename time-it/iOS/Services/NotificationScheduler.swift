import Foundation
import UserNotifications

/// Schedules local notifications for every upcoming cue (and completion) of each
/// running timer, so alerts still fire when the app is suspended in the
/// background — the OS, not our process, delivers them.
///
/// While the app is in the foreground the in-app speech/haptics handle cues, so
/// the delegate suppresses notification presentation to avoid doubling up.
@MainActor
final class NotificationScheduler: NSObject, UNUserNotificationCenterDelegate {

    private let center = UNUserNotificationCenter.current()
    private static let prefix = "timeit."

    func configure() {
        center.delegate = self
    }

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Replace all pending Time It notifications with a fresh schedule derived
    /// from the current running timers.
    func reschedule(for running: [RunningTimerState], now: Date = Date()) {
        center.getPendingNotificationRequests { [weak self] pending in
            guard let self else { return }
            let ours = pending.map(\.identifier).filter { $0.hasPrefix(Self.prefix) }
            self.center.removePendingNotificationRequests(withIdentifiers: ours)

            for timer in running where timer.isRunning {
                self.schedule(timer, now: now)
            }
        }
    }

    func cancelAll() {
        center.getPendingNotificationRequests { [weak self] pending in
            let ours = pending.map(\.identifier).filter { $0.hasPrefix(Self.prefix) }
            self?.center.removePendingNotificationRequests(withIdentifiers: ours)
        }
    }

    // MARK: Scheduling

    /// iOS keeps only the ~64 soonest pending notifications per app and silently
    /// drops the rest — which, on a long interval timer with hundreds of cues,
    /// would drop the *end* notification first (it's the furthest out). So:
    /// schedule the end unconditionally and only the nearest cues up to a cap.
    private static let maxCues = 60

    private func schedule(_ timer: RunningTimerState, now: Date) {
        let id = timer.id.uuidString
        let elapsed = timer.elapsed(now: now)
        let name = timer.preset.displayName

        let remaining = timer.remaining(now: now)
        if remaining > 0.5 {
            add(identifier: "\(Self.prefix)\(id).end",
                title: name, body: "Time's up", after: remaining)
        }

        for cue in timer.cues.filter({ $0.fireTime > elapsed }).prefix(Self.maxCues) {
            let after = cue.fireTime - elapsed
            add(identifier: "\(Self.prefix)\(id).\(cue.id)",
                title: name, body: cue.displayLabel, after: after)
        }
    }

    private func add(identifier: String, title: String, body: String, after: TimeInterval) {
        guard after > 0 else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: after, repeats: false)
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
    }

    // MARK: Delegate — suppress while foregrounded (in-app cues handle it).

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }
}
