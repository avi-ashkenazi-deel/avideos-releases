import SwiftUI

/// Compact preset list synced from the phone. Tap to start a timer on the watch.
struct WatchTimerListView: View {
    @EnvironmentObject private var engine: TimerEngine
    @EnvironmentObject private var presets: PresetStore

    var body: some View {
        List {
            if presets.presets.isEmpty {
                Text("No timers yet. Add some on your iPhone.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(presets.presets) { preset in
                Button {
                    engine.start(preset)
                } label: {
                    HStack {
                        Circle().fill(Color(hex: preset.colorHex)).frame(width: 10, height: 10)
                        VStack(alignment: .leading) {
                            Text(preset.name).font(.headline)
                            Text(formatClock(preset.duration))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "play.fill").foregroundStyle(Color(hex: preset.colorHex))
                    }
                }
            }
        }
    }
}
