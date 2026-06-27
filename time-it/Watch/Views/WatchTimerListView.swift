import SwiftUI

/// Compact preset list synced from the phone. Tap to start a timer on the watch,
/// or start a freestyle session.
struct WatchTimerListView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var presets: PresetStore
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        List {
            Button {
                model.startSession()
            } label: {
                Label("Free workout", systemImage: settings.sessionWorkoutKind.symbol)
            }

            if presets.presets.isEmpty {
                Text("No timers yet. Add some on your iPhone.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(presets.presets) { preset in
                Button {
                    start(preset)
                } label: {
                    HStack {
                        Circle().fill(Color(hex: preset.colorHex)).frame(width: 10, height: 10)
                        VStack(alignment: .leading) {
                            Text(preset.displayName).font(.headline)
                            Text(formatClock(preset.duration))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "play.fill").foregroundStyle(Color(hex: preset.colorHex))
                    }
                }
            }
        }
        .navigationTitle("Time It")
    }

    private func start(_ preset: TimerPreset) {
        model.startTimer(preset)
    }
}
