import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// Starts, updates, and ends a Live Activity per running timer so progress shows
/// on the Lock Screen and in the Dynamic Island, and the timer keeps visibly
/// counting after you leave the app. Driven by `TimerEngine.onTimersChanged`.
@available(iOS 16.2, *)
@MainActor
final class LiveActivityController {

    private var activities: [String: Activity<TimerActivityAttributes>] = [:]

    /// Reconcile live activities against the current set of running timers:
    /// start ones that are new, update the rest, end ones that disappeared.
    func sync(_ running: [RunningTimerState], now: Date = Date()) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let liveIDs = Set(running.map { $0.id.uuidString })

        // End activities whose timer is gone.
        for (id, activity) in activities where !liveIDs.contains(id) {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            activities[id] = nil
        }

        for timer in running {
            let id = timer.id.uuidString
            let state = contentState(for: timer, now: now)
            if let activity = activities[id] {
                Task { await activity.update(ActivityContent(state: state, staleDate: timer.endDate(now: now))) }
            } else {
                start(id: id, state: state, staleDate: timer.endDate(now: now))
            }
        }
    }

    /// End everything (e.g. on Stop All).
    func endAll() {
        for (_, activity) in activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        activities.removeAll()
    }

    // MARK: Helpers

    private func start(id: String, state: TimerActivityAttributes.ContentState, staleDate: Date) {
        do {
            let activity = try Activity.request(
                attributes: TimerActivityAttributes(timerID: id),
                content: ActivityContent(state: state, staleDate: staleDate),
                pushType: nil
            )
            activities[id] = activity
        } catch {
            #if DEBUG
            print("LiveActivity start failed: \(error)")
            #endif
        }
    }

    private func contentState(for timer: RunningTimerState,
                              now: Date) -> TimerActivityAttributes.ContentState {
        let remaining = timer.remaining(now: now)
        return .init(
            name: timer.preset.displayName,
            startDate: now.addingTimeInterval(-timer.elapsed(now: now)),
            endDate: now.addingTimeInterval(remaining),
            isRunning: timer.isRunning,
            pausedRemaining: remaining,
            colorHex: timer.preset.colorHex,
            nextCueLabel: timer.nextCueLabel(now: now)
        )
    }
}
#endif
