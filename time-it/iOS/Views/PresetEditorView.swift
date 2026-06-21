import SwiftUI

/// Create or edit a timer. The flow leads with the **total time**, then an
/// **intervals** plan (even split / every-N-seconds / custom one-by-one). On top
/// of intervals you can keep extras: a final spoken countdown, one-off custom
/// cues, an output-mode default, repeats, and a name.
///
/// Reused both for creating a preset and for **editing a running timer live**
/// (the caller decides what `onSave` does).
struct PresetEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TimerPreset
    private let title: String
    private let onSave: (TimerPreset) -> Void

    init(preset: TimerPreset, title: String = "Timer", onSave: @escaping (TimerPreset) -> Void) {
        _draft = State(initialValue: preset)
        self.title = title
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                    ColorPickerRow(selection: $draft.colorHex)
                }

                Section("Total time") {
                    DurationPicker(seconds: $draft.duration)
                }

                Section {
                    Toggle("Record as Apple Watch workout", isOn: Binding(
                        get: { draft.recordsWorkout ?? true },
                        set: { draft.recordsWorkout = $0 }
                    ))
                } footer: {
                    Text("Turn off for non-exercise timers (a talk, cooking…) so the watch doesn't log a workout to Fitness.")
                }

                IntervalsSection(plan: $draft.intervals, duration: draft.duration)

                Section("Final countdown") {
                    Toggle("Speak the last seconds", isOn: finalCountdownEnabled)
                    if let cd = draft.finalCountdown {
                        Stepper("Last \(cd.lastSeconds) seconds",
                                value: lastSecondsBinding, in: 3...30)
                        Toggle("Buzz each second", isOn: countdownHapticBinding)
                    }
                }

                Section {
                    ForEach($draft.milestones) { $m in
                        MilestoneEditorRow(milestone: $m, duration: draft.duration)
                    }
                    .onDelete { draft.milestones.remove(atOffsets: $0) }

                    Button {
                        draft.milestones.append(
                            TimerMilestone(trigger: .secondsRemaining(30), alert: .voiceAndHaptic)
                        )
                    } label: { Label("Add a one-off cue", systemImage: "plus") }
                } header: {
                    Text("Extra cues")
                } footer: {
                    Text("One-off markers on top of the intervals — e.g. \"30 seconds left\" or \"halfway\".")
                }

                Section {
                    Picker("On start, switch to", selection: defaultModeBinding) {
                        Text("Leave as-is").tag(DefaultModeChoice.unchanged)
                        ForEach(OutputMode.allCases) { mode in
                            Text(mode.displayName).tag(DefaultModeChoice.set(mode))
                        }
                    }
                } header: {
                    Text("Output mode")
                } footer: {
                    Text("Starting this timer can flip the app to Voice, Vibrate, or Both — handy for a silent \"talk\" preset.")
                }

                Section("Options") {
                    Stepper("Repeat \(draft.repeatCount)×", value: $draft.repeatCount, in: 1...50)
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(draft); dismiss() }
                        .disabled(draft.duration <= 0 || customIntervalsOverTotal)
                }
            }
        }
    }

    /// Custom intervals that add up to more than the total make trailing cues
    /// impossible — block Save until they're fixed (Even/Every/Work-Rest always
    /// fit, so they never trip this).
    private var customIntervalsOverTotal: Bool {
        if case .custom(let lengths)? = draft.intervals?.spec {
            return lengths.reduce(0, +) - draft.duration > 0.5
        }
        return false
    }

    // MARK: Default output mode

    private enum DefaultModeChoice: Hashable {
        case unchanged
        case set(OutputMode)
    }

    private var defaultModeBinding: Binding<DefaultModeChoice> {
        Binding(
            get: { draft.defaultOutputMode.map(DefaultModeChoice.set) ?? .unchanged },
            set: { choice in
                switch choice {
                case .unchanged: draft.defaultOutputMode = nil
                case .set(let m): draft.defaultOutputMode = m
                }
            }
        )
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

// MARK: - Intervals section

private struct IntervalsSection: View {
    @Binding var plan: IntervalPlan?
    let duration: TimeInterval

    private enum Mode: String, CaseIterable, Identifiable {
        case even = "Even"
        case spacing = "Every"
        case custom = "Custom"
        case workRest = "Work/Rest"
        var id: String { rawValue }
    }

    var body: some View {
        Section {
            Toggle("Use intervals", isOn: enabledBinding)

            if let plan {
                Picker("Mode", selection: modeBinding) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                modeControls(plan)

                // Summary of how it splits up.
                Text(summary(plan))
                    .font(.caption).foregroundStyle(.secondary)

                Toggle("Announce interval number", isOn: announceBinding)

                Toggle("Count down into each interval", isOn: countdownEnabledBinding)
                if (plan.countdown ?? 0) > 0 {
                    Stepper("Last \(plan.countdown ?? 0)s of each interval",
                            value: countdownBinding, in: 1...10)
                }

                HStack {
                    Toggle("Voice", isOn: alertBinding(.voice)).toggleStyle(.button)
                    Toggle("Haptic", isOn: alertBinding(.haptic)).toggleStyle(.button)
                    Spacer()
                    if plan.alert.includesHaptic {
                        Picker("Buzz", selection: hapticBinding) {
                            ForEach(HapticPattern.allCases) { Text($0.displayName).tag($0) }
                        }
                        .labelsHidden()
                    }
                }
                .font(.caption)
            }
        } header: {
            Text("Intervals")
        } footer: {
            Text("Split the total into announced intervals — evenly, every N seconds, custom lengths one by one, or repeating work/rest sets.")
        }
    }

    /// For custom intervals: warn when the lengths don't add up to the total and
    /// offer a one-tap fix. Even / Every / Work-Rest always fit by construction,
    /// so they never need this.
    @ViewBuilder private var customValidation: some View {
        let total = customLengths.reduce(0, +)
        let delta = total - duration
        if delta > 0.5 {
            // Over the total: the trailing intervals won't fully happen.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Intervals total \(formatClock(total)) — \(formatClock(delta)) over the \(formatClock(duration)) total.")
                    Text("Reduce by \(formatClock(delta)), or fix it automatically.")
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
                Spacer()
                Button("Fix") { setSpec(.custom(lengths: Self.trimmed(customLengths, toTotal: duration))) }
                    .font(.caption.bold())
                    .buttonStyle(.borderedProminent)
            }
        } else if delta < -0.5 {
            // Under the total: the last interval simply runs longer — informational.
            Label("Last interval runs an extra \(formatClock(-delta)) to fill the total.",
                  systemImage: "info.circle")
                .font(.caption).foregroundStyle(.secondary)
        } else {
            Label("Fits the total exactly.", systemImage: "checkmark.circle")
                .font(.caption).foregroundStyle(.green)
        }
    }

    /// Trim interval lengths from the end until they sum to `total`, dropping any
    /// that would shrink below a 5s minimum. Earlier intervals are left intact —
    /// we only take the excess off the end.
    static func trimmed(_ lengths: [TimeInterval], toTotal total: TimeInterval) -> [TimeInterval] {
        var arr = lengths
        var sum = arr.reduce(0, +)
        var i = arr.count - 1
        while sum - total > 0.5, i >= 0 {
            let over = sum - total
            if arr[i] - over >= 5 {
                arr[i] -= over
                sum -= over
            } else {
                sum -= arr[i]
                arr.remove(at: i)
            }
            i -= 1
        }
        return arr
    }

    @ViewBuilder private func modeControls(_ plan: IntervalPlan) -> some View {
        switch currentMode {
        case .even:
            Stepper("\(evenCount) intervals", value: evenCountBinding, in: 2...60)
        case .spacing:
            Stepper("Every \(Int(spacingSeconds)) seconds",
                    value: spacingBinding, in: 5...max(5, duration), step: 5)
        case .custom:
            ForEach(Array(customLengths.enumerated()), id: \.offset) { idx, _ in
                Stepper("Interval \(idx + 1): \(Int(customLengths[idx]))s",
                        value: customLengthBinding(idx), in: 5...max(5, duration), step: 5)
            }
            .onDelete { offsets in
                var arr = customLengths
                arr.remove(atOffsets: offsets)
                setSpec(.custom(lengths: arr))
            }
            Button {
                setSpec(.custom(lengths: customLengths + [30]))
            } label: { Label("Add interval", systemImage: "plus") }
            customValidation
        case .workRest:
            Stepper("Work \(formatClock(workSeconds))",
                    value: workBinding, in: 5...max(5, duration), step: 5)
            Stepper("Rest \(formatClock(restSeconds))",
                    value: restBinding, in: 5...max(5, duration), step: 5)
        }
    }

    private func summary(_ plan: IntervalPlan) -> String {
        if case .workRest = plan.spec {
            let cues = plan.boundaries(forDuration: duration).count
            // Each full round is one work + one rest segment.
            let rounds = Int((duration / max(1, workSeconds + restSeconds)).rounded(.down))
            return "≈\(rounds) round\(rounds == 1 ? "" : "s") · \(cues) cue\(cues == 1 ? "" : "s")"
        }
        let count = plan.intervalCount(forDuration: duration)
        let bounds = plan.boundaries(forDuration: duration).count
        return "\(count) interval\(count == 1 ? "" : "s") · \(bounds) cue\(bounds == 1 ? "" : "s")"
    }

    // MARK: Bindings

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { plan != nil },
            set: { plan = $0 ? IntervalPlan(spec: .even(count: 4)) : nil }
        )
    }

    private var currentMode: Mode {
        switch plan?.spec {
        case .even: return .even
        case .spacing: return .spacing
        case .custom: return .custom
        case .workRest: return .workRest
        case .none: return .even
        }
    }
    private var modeBinding: Binding<Mode> {
        Binding(get: { currentMode }, set: { mode in
            switch mode {
            case .even: setSpec(.even(count: max(2, plan?.intervalCount(forDuration: duration) ?? 4)))
            case .spacing: setSpec(.spacing(seconds: spacingSeconds))
            case .custom: setSpec(.custom(lengths: customLengths))
            case .workRest: setSpec(.workRest(work: workSeconds, rest: restSeconds))
            }
        })
    }

    private var workSeconds: TimeInterval {
        if case .workRest(let w, _)? = plan?.spec { return w }
        return min(60, max(5, duration / 3))
    }
    private var restSeconds: TimeInterval {
        if case .workRest(_, let r)? = plan?.spec { return r }
        return min(20, max(5, duration / 6))
    }
    private var workBinding: Binding<TimeInterval> {
        Binding(get: { workSeconds }, set: { setSpec(.workRest(work: $0, rest: restSeconds)) })
    }
    private var restBinding: Binding<TimeInterval> {
        Binding(get: { restSeconds }, set: { setSpec(.workRest(work: workSeconds, rest: $0)) })
    }

    private var evenCount: Int {
        if case .even(let c)? = plan?.spec { return c }
        return 4
    }
    private var evenCountBinding: Binding<Int> {
        Binding(get: { evenCount }, set: { setSpec(.even(count: $0)) })
    }

    private var spacingSeconds: TimeInterval {
        if case .spacing(let s)? = plan?.spec { return s }
        return min(30, max(5, duration / 4))
    }
    private var spacingBinding: Binding<TimeInterval> {
        Binding(get: { spacingSeconds }, set: { setSpec(.spacing(seconds: $0)) })
    }

    private var customLengths: [TimeInterval] {
        if case .custom(let l)? = plan?.spec, !l.isEmpty { return l }
        // Seed from an even split so "custom" starts from something sensible.
        let n = 4
        return Array(repeating: duration / Double(n), count: n)
    }
    private func customLengthBinding(_ idx: Int) -> Binding<TimeInterval> {
        Binding(
            get: { idx < customLengths.count ? customLengths[idx] : 30 },
            set: { newVal in
                var arr = customLengths
                if idx < arr.count { arr[idx] = newVal }
                setSpec(.custom(lengths: arr))
            }
        )
    }

    private var announceBinding: Binding<Bool> {
        Binding(get: { plan?.announceNumber ?? true }, set: { plan?.announceNumber = $0 })
    }
    private var countdownEnabledBinding: Binding<Bool> {
        Binding(
            get: { (plan?.countdown ?? 0) > 0 },
            set: { plan?.countdown = $0 ? 5 : nil }   // default to a 5s countdown
        )
    }
    private var countdownBinding: Binding<Int> {
        Binding(get: { plan?.countdown ?? 5 }, set: { plan?.countdown = $0 })
    }
    private var hapticBinding: Binding<HapticPattern> {
        Binding(get: { plan?.haptic ?? .notification }, set: { plan?.haptic = $0 })
    }
    private func alertBinding(_ option: AlertStyle) -> Binding<Bool> {
        Binding(
            get: { plan?.alert.contains(option) ?? false },
            set: { on in
                guard plan != nil else { return }
                if on { plan?.alert.insert(option) } else { plan?.alert.remove(option) }
            }
        )
    }

    private func setSpec(_ spec: IntervalPlan.Spec) {
        if plan == nil { plan = IntervalPlan(spec: spec) } else { plan?.spec = spec }
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
    @State private var expanded = false

    var body: some View {
        // A swatch row that expands to a row of *actual* colored circles. (A
        // `Menu` renders its icons monochrome, so the colors wouldn't show.)
        Button { withAnimation(.snappy) { expanded.toggle() } } label: {
            HStack {
                Text("Color").foregroundStyle(.primary)
                Spacer()
                Circle().fill(Color(hex: selection)).frame(width: 24, height: 24)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if expanded {
            HStack(spacing: 16) {
                ForEach(PresetPalette.hexes, id: \.self) { hex in
                    Button {
                        selection = hex
                        withAnimation(.snappy) { expanded = false }
                    } label: {
                        Circle()
                            .fill(Color(hex: hex))
                            .frame(width: 30, height: 30)
                            .overlay(
                                Circle().strokeBorder(.primary,
                                                      lineWidth: selection == hex ? 3 : 0)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(PresetPalette.name(for: hex))
                }
                Spacer()
            }
            .padding(.vertical, 4)
        }
    }
}

// MARK: - One-off cue (milestone) editor row

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
        VStack(alignment: .leading, spacing: 14) {
            Picker("When", selection: kindBinding) {
                ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            valueControl
                .padding(.top, 2)

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
            VStack(alignment: .leading) {
                Text("\(Int(percentValue * 100))%").font(.caption).foregroundStyle(.secondary)
                Slider(value: percentBinding, in: 0.05...0.95, step: 0.05)
            }
        case .secondsRemaining:
            // Show seconds under a minute, then m:ss so e.g. 90s reads "1:30".
            Stepper(secondsValue < 60 ? "\(Int(secondsValue))s left"
                                      : "\(formatClock(secondsValue)) left",
                    value: secondsBinding, in: 5...max(5, duration), step: 5)
        }
    }

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
