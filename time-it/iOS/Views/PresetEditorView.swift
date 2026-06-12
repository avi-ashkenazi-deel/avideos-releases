import SwiftUI

/// Create or edit a timer preset: duration, color, repeats, milestones (each
/// percentage- or seconds-remaining-based with its own voice/haptic style), and
/// the final spoken countdown.
struct PresetEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TimerPreset
    private let onSave: (TimerPreset) -> Void

    init(preset: TimerPreset, onSave: @escaping (TimerPreset) -> Void) {
        _draft = State(initialValue: preset)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Timer") {
                    TextField("Name", text: $draft.name)
                    DurationPicker(seconds: $draft.duration)
                    Stepper("Repeat \(draft.repeatCount)×", value: $draft.repeatCount, in: 1...50)
                    ColorPickerRow(selection: $draft.colorHex)
                }

                Section("Final countdown") {
                    Toggle("Speak the last seconds", isOn: finalCountdownEnabled)
                    if let cd = draft.finalCountdown {
                        Stepper("Last \(cd.lastSeconds) seconds",
                                value: lastSecondsBinding, in: 3...30)
                        Toggle("Buzz each second", isOn: countdownHapticBinding)
                    }
                }

                Section("Milestones") {
                    ForEach($draft.milestones) { $m in
                        MilestoneEditorRow(milestone: $m, duration: draft.duration)
                    }
                    .onDelete { draft.milestones.remove(atOffsets: $0) }

                    Button {
                        draft.milestones.append(
                            TimerMilestone(trigger: .percentElapsed(0.5), alert: .voiceAndHaptic)
                        )
                    } label: { Label("Add milestone", systemImage: "plus") }
                }
            }
            .navigationTitle(draft.name.isEmpty ? "Timer" : draft.name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(draft); dismiss() }
                        .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty || draft.duration <= 0)
                }
            }
        }
    }

    // MARK: Bindings into the optional final-countdown

    private var finalCountdownEnabled: Binding<Bool> {
        Binding(
            get: { draft.finalCountdown != nil },
            set: { draft.finalCountdown = $0 ? FinalCountdown() : nil }
        )
    }
    private var lastSecondsBinding: Binding<Int> {
        Binding(
            get: { draft.finalCountdown?.lastSeconds ?? 10 },
            set: { draft.finalCountdown?.lastSeconds = $0 }
        )
    }
    private var countdownHapticBinding: Binding<Bool> {
        Binding(
            get: { draft.finalCountdown?.haptic ?? true },
            set: { draft.finalCountdown?.haptic = $0 }
        )
    }
}

// MARK: - Duration picker (h / m / s wheels)

private struct DurationPicker: View {
    @Binding var seconds: TimeInterval

    private var hours: Int { Int(seconds) / 3600 }
    private var minutes: Int { (Int(seconds) % 3600) / 60 }
    private var secs: Int { Int(seconds) % 60 }

    var body: some View {
        HStack {
            wheel("h", value: hours, range: 0...5) { setComponents(h: $0, m: minutes, s: secs) }
            wheel("m", value: minutes, range: 0...59) { setComponents(h: hours, m: $0, s: secs) }
            wheel("s", value: secs, range: 0...59) { setComponents(h: hours, m: minutes, s: $0) }
        }
        .frame(height: 120)
    }

    private func wheel(_ label: String, value: Int, range: ClosedRange<Int>,
                       set: @escaping (Int) -> Void) -> some View {
        VStack {
            Picker(label, selection: Binding(get: { value }, set: set)) {
                ForEach(range, id: \.self) { Text("\($0)").tag($0) }
            }
            .pickerStyle(.wheel)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func setComponents(h: Int, m: Int, s: Int) {
        seconds = TimeInterval(h * 3600 + m * 60 + s)
    }
}

// MARK: - Color picker row

private struct ColorPickerRow: View {
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 14) {
            ForEach(PresetPalette.hexes, id: \.self) { hex in
                Circle()
                    .fill(Color(hex: hex))
                    .frame(width: 28, height: 28)
                    .overlay(Circle().stroke(.primary, lineWidth: selection == hex ? 2 : 0))
                    .onTapGesture { selection = hex }
            }
        }
    }
}

// MARK: - Milestone editor row

private struct MilestoneEditorRow: View {
    @Binding var milestone: TimerMilestone
    let duration: TimeInterval

    private enum Kind: String, CaseIterable, Identifiable {
        case percentElapsed = "% elapsed"
        case percentRemaining = "% left"
        case secondsRemaining = "sec left"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("When", selection: kindBinding) {
                ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            valueControl

            TextField("Spoken label (optional)", text: labelBinding)
                .font(.subheadline)

            HStack {
                Toggle("Voice", isOn: alertBinding(.voice)).toggleStyle(.button)
                Toggle("Haptic", isOn: alertBinding(.haptic)).toggleStyle(.button)
                Spacer()
                if milestone.alert.includesHaptic {
                    Picker("Buzz", selection: $milestone.haptic) {
                        ForEach(HapticPattern.allCases) { Text($0.displayName).tag($0) }
                    }
                    .labelsHidden()
                }
            }
            .font(.caption)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var valueControl: some View {
        switch currentKind {
        case .percentElapsed, .percentRemaining:
            let pct = percentValue
            VStack(alignment: .leading) {
                Text("\(Int(pct * 100))%").font(.caption).foregroundStyle(.secondary)
                Slider(value: percentBinding, in: 0.05...0.95, step: 0.05)
            }
        case .secondsRemaining:
            Stepper("\(Int(secondsValue)) seconds left",
                    value: secondsBinding, in: 5...max(5, duration), step: 5)
        }
    }

    // MARK: derived

    private var currentKind: Kind {
        switch milestone.trigger {
        case .percentElapsed: return .percentElapsed
        case .percentRemaining: return .percentRemaining
        case .secondsRemaining: return .secondsRemaining
        }
    }
    private var percentValue: Double {
        switch milestone.trigger {
        case .percentElapsed(let f), .percentRemaining(let f): return f
        case .secondsRemaining: return 0.5
        }
    }
    private var secondsValue: TimeInterval {
        if case .secondsRemaining(let s) = milestone.trigger { return s }
        return 30
    }

    private var kindBinding: Binding<Kind> {
        Binding(get: { currentKind }, set: { kind in
            switch kind {
            case .percentElapsed: milestone.trigger = .percentElapsed(percentValue)
            case .percentRemaining: milestone.trigger = .percentRemaining(percentValue)
            case .secondsRemaining: milestone.trigger = .secondsRemaining(secondsValue)
            }
        })
    }
    private var percentBinding: Binding<Double> {
        Binding(get: { percentValue }, set: { f in
            milestone.trigger = currentKind == .percentRemaining ? .percentRemaining(f) : .percentElapsed(f)
        })
    }
    private var secondsBinding: Binding<TimeInterval> {
        Binding(get: { secondsValue }, set: { milestone.trigger = .secondsRemaining($0) })
    }
    private var labelBinding: Binding<String> {
        Binding(get: { milestone.label ?? "" }, set: { milestone.label = $0.isEmpty ? nil : $0 })
    }
    private func alertBinding(_ option: AlertStyle) -> Binding<Bool> {
        Binding(
            get: { milestone.alert.contains(option) },
            set: { on in
                if on { milestone.alert.insert(option) } else { milestone.alert.remove(option) }
            }
        )
    }
}
