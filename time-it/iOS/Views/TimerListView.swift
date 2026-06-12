import SwiftUI

/// The preset library: start, edit, delete, or create timers.
struct TimerListView: View {
    @EnvironmentObject private var engine: TimerEngine
    @EnvironmentObject private var presets: PresetStore
    @State private var editing: TimerPreset?
    @State private var creatingNew = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(presets.presets) { preset in
                    PresetRow(preset: preset) {
                        engine.start(preset)
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
                PresetEditorView(preset: preset) { presets.update($0) }
            }
            .sheet(isPresented: $creatingNew) {
                PresetEditorView(preset: TimerPreset(name: "New timer", duration: 60)) {
                    presets.add($0)
                }
            }
        }
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
                Text(preset.name).font(.headline)
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
        if !preset.milestones.isEmpty {
            parts.append("\(preset.milestones.count) milestone\(preset.milestones.count == 1 ? "" : "s")")
        }
        if preset.repeatCount > 1 { parts.append("×\(preset.repeatCount)") }
        return parts.joined(separator: " · ")
    }
}
