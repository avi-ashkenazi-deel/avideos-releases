import SwiftUI

/// One screen, two states: the timer library, and — once you press play on a
/// timer — the running view. Only one timer runs at a time, so the running view
/// fully takes over and returns to the library when you stop.
struct RootView: View {
    @EnvironmentObject private var engine: TimerEngine
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if !engine.running.isEmpty {
                RunningTimerScreen()
            } else if model.inSession {
                SessionScreen()
            } else {
                TimerListView()
            }
        }
        .animation(.snappy, value: engine.running.isEmpty)
        .animation(.snappy, value: model.inSession)
    }
}

#Preview {
    let model = AppModel()
    return RootView()
        .environmentObject(model)
        .environmentObject(model.engine)
        .environmentObject(model.presets)
        .environmentObject(model.settings)
}
