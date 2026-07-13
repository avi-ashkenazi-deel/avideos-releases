import SwiftUI

/// Watch root, three states:
///  - a timer running → the live running view,
///  - a freestyle session open → the session view (count-up + rest buttons),
///  - otherwise → the timer list.
struct WatchRootView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var engine: TimerEngine

    var body: some View {
        Group {
            if !engine.running.isEmpty {
                WatchRunningView()
            } else if model.inSession {
                WatchSessionView()
            } else {
                WatchTimerListView()
            }
        }
        .onAppear { model.keepAlive.requestAuthorization() }
    }
}
