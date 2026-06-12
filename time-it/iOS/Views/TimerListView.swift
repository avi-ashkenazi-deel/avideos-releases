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
                Section {
                    OutputModePicker()
                } header: { Text("Announce with") }

                ForEach(presets.presets) { preset in
                    PresetRow(preset: preset) {
                        start(preset)
                    }
                    .contentShape(Rectangle())
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
                                        intervals: IntervalPlan(spec: .even(count: 4))),
                    title: "New timer"
                ) { presets.add($0) }
            }
        }
    }

    /// Start a preset, first applying its default output mode (if it carries one).
    private func start(_ preset: TimerPreset) {
        if let mode = preset.defaultOutputMode { settings.outputMode = mode }
        engine.start(preset)
    }
}

private struct PresetRow: View {
    let preset: TimerPreset
    let onStart: () -> Void

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
            Button(action: onStart) {
                Image(systemName: "play.circle.fill")
                    .font(.title)
                    .foregroundStyle(Color(hex: preset.colorHex))
            }
            .buttonStyle(.plain)
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
