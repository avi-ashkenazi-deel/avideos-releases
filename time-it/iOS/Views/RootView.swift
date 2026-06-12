import SwiftUI

/// Two tabs: the live dashboard of running timers, and the preset library. When
/// a timer is running the app focuses the Running tab automatically — there's no
/// point lingering on the setup screen unless you go there deliberately.
struct RootView: View {
    @EnvironmentObject private var engine: TimerEngine

    private enum Tab { case running, timers }
    @State private var selection: Tab = .timers

    var body: some View {
        TabView(selection: $selection) {
            RunningTimersView()
                .tabItem { Label("Running", systemImage: "timer") }
                .tag(Tab.running)

            TimerListView()
                .tabItem { Label("Timers", systemImage: "list.bullet") }
                .tag(Tab.timers)
        }
        .onChange(of: engine.running.isEmpty) { _, isEmpty in
            // Jump to the running view when a timer starts; fall back to the
            // library when the last one ends.
            selection = isEmpty ? .timers : .running
        }
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
