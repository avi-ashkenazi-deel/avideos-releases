import SwiftUI

/// Watch root: if timers are running, show the live view; otherwise the preset
/// list to start one.
struct WatchRootView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var engine: TimerEngine

    var body: some View {
        Group {
            if engine.running.isEmpty {
                WatchTimerListView()
            } else {
                WatchRunningView()
            }
        }
        .navigationTitle("Time It")
        .onAppear { model.keepAlive.requestAuthorization() }
    }
}
