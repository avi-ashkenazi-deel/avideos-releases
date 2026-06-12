import SwiftUI

/// Two tabs: the live dashboard of running timers, and the preset library.
struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        TabView {
            RunningTimersView()
                .tabItem { Label("Running", systemImage: "timer") }

            TimerListView()
                .tabItem { Label("Timers", systemImage: "list.bullet") }
        }
    }
}

#Preview {
    let model = AppModel()
    return RootView()
        .environmentObject(model)
        .environmentObject(model.engine)
        .environmentObject(model.presets)
}
