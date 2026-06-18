import SwiftUI

/// The preset library: start, edit, delete, or create timers.
struct TimerListView: View {
    @EnvironmentObject private var engine: TimerEngine
    @EnvironmentObject private var presets: PresetStore
    @EnvironmentObject private var settings: AppSettings
    @State private var editing: TimerPreset?
    @State private var creatingNew = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(presets.presets) { preset in
                    // Tapping anywhere on the row starts the timer; swipe still
                    // exposes Edit / Delete.
                    Button { start(preset) } label: { PresetRow(preset: preset) }
                        .buttonStyle(.plain)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                presets.delete(id: preset.id)
                            } label: { Label("Delete", systemImage: "trash") }
                            Button {
                                editing = preset
                            } label: { Label("Edit", systemImage: "pencil") }
                            .tint(.blue)
                        }
                }
            }
            .navigationTitle("Time It")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creatingNew = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(item: $editing) { preset in
                PresetEditorView(preset: preset, title: "Edit timer") { presets.update($0) }
            }
            .sheet(isPresented: $creatingNew) {
                PresetEditorView(
                    preset: TimerPreset(duration: 300,
                                        intervals: IntervalPlan(spec: .even(count: 4)),
                                        colorHex: PresetPalette.random),
                    title: "New timer"
                ) { presets.add($0) }
            }
        }
    }

    /// Start a preset (single timer at a time), applying its default output mode
    /// (if it carries one) and stopping any current timer first.
    private func start(_ preset: TimerPreset) {
        if let mode = preset.defaultOutputMode { settings.outputMode = mode }
        engine.stopAll()
        engine.start(preset)
    }
}

private struct PresetRow: View {
    let preset: TimerPreset

    var body: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(Color(hex: preset.colorHex))
                .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(preset.displayName).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            // Output indicators: voice and/or vibrate, and whether it logs a workout.
            HStack(spacing: 8) {
                if preset.usesVoice {
                    Image(systemName: "speaker.wave.2.fill")
                }
                if preset.usesHaptic {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                }
                if preset.isWorkout {
                    Image(systemName: "figure.strengthtraining.traditional")
                        .foregroundStyle(.green)
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            Image(systemName: "play.circle.fill")
                .font(.title)
                .foregroundStyle(Color(hex: preset.colorHex))
        }
        .padding(.vertical, 4)
    }

    private var subtitle: String {
        var parts = [formatClock(preset.duration)]
        let cueCount = preset.cues().count
        if cueCount > 0 {
            parts.append("\(cueCount) cue\(cueCount == 1 ? "" : "s")")
        }
        if preset.repeatCount > 1 { parts.append("×\(preset.repeatCount)") }
        return parts.joined(separator: " · ")
    }
}
