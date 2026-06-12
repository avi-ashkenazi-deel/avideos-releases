import SwiftUI

/// Compact preset list synced from the phone. Tap to start a timer on the watch.
struct WatchTimerListView: View {
    @EnvironmentObject private var engine: TimerEngine
    @EnvironmentObject private var presets: PresetStore
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        List {
            Picker("Announce", selection: $settings.outputMode) {
                ForEach(OutputMode.allCases) { mode in
                    Label(mode.displayName, systemImage: mode.systemImage).tag(mode)
                }
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

    private func start(_ preset: TimerPreset) {
        if let mode = preset.defaultOutputMode { settings.outputMode = mode }
        engine.start(preset)
    }
}
