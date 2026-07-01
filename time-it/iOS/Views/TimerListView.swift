import SwiftUI

/// The preset library: start, edit, delete, or create timers.
struct TimerListView: View {
    @EnvironmentObject private var engine: TimerEngine
    @EnvironmentObject private var presets: PresetStore
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var model: AppModel
    @State private var editing: TimerPreset?
    @State private var creatingNew = false
    @State private var editingSession = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    // The open-ended workout: counts up, tap a rest between sets.
                    // Styled like a preset row (not a tinted button); swipe to edit
                    // its activity type + rest buttons.
                    Button { model.startSession() } label: {
                        FreeWorkoutRow(kind: settings.sessionWorkoutKind)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing) {
                        Button { editingSession = true } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                }

                Section {
                    ForEach(presets.presets) { preset in
                        // Tapping anywhere on the row starts the timer; swipe still
                        // exposes Edit / Delete; drag (in Edit mode) reorders.
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
                    .onMove(perform: presets.move)
                    .onDelete { presets.delete(at: $0) }
                } footer: {
                    // So you can confirm on-device / in TestFlight exactly which
                    // build is installed.
                    Text(Self.versionString)
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 8)
                }
            }
            .navigationTitle("Time It")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
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
                                        intervals: nil,          // intervals off by default
                                        finalCountdown: nil,     // countdown off by default
                                        colorHex: PresetPalette.random),
                    title: "New timer"
                ) { presets.add($0) }
            }
            .sheet(isPresented: $editingSession) { SessionSettingsView() }
        }
    }

    /// Start a preset (single timer at a time), stopping any current timer first.
    private func start(_ preset: TimerPreset) {
        engine.stopAll()
        engine.start(preset)
    }

    /// "Time It 0.2.0 (1)" — the version + build actually compiled into this copy.
    static var versionString: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "Time It \(v) (\(b))"
    }
}

/// The "Free workout" row — matches the look of a preset row, showing the
/// chosen activity's icon and a play button instead of accent-tinted text.
private struct FreeWorkoutRow: View {
    let kind: WorkoutKind

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: kind.symbol)
                .font(.title3)
                .foregroundStyle(.orange)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Free workout").font(.headline)
                Text("Count up, rest when you need it")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "play.circle.fill")
                .font(.title)
                .foregroundStyle(.orange)
        }
        .padding(.vertical, 4)
        .foregroundStyle(.primary)
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
                    Image(systemName: "circle.circle")   // "tracked in Fitness"
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
