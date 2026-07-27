import SwiftUI

/// Connected controllers, a live message monitor, and learn-mode bindings.
struct MIDISettingsView: View {
    @Environment(StudioController.self) private var studio

    private var midi: MIDIController { studio.midi }

    var body: some View {
        Form {
            Section("Devices") {
                if midi.deviceNames.isEmpty {
                    Text("No MIDI controllers found. Connect one by USB — it is picked up automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(midi.deviceNames, id: \.self) { name in
                        HStack {
                            Circle().fill(Color.green).frame(width: 7, height: 7)
                            Text(name)
                        }
                    }
                }
                // Shown whether or not anything is bound: a controller that
                // seems to send nothing is the case you most need to debug,
                // and hiding the raw traffic is how that becomes unanswerable.
                LabeledContent("Last message") {
                    Text(midi.lastMessage?.displayDescription ?? "—")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }

            Section("Bindings") {
                if let learning = midi.learningAction {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Press a control for \(learning.displayName)…")
                            .font(.caption)
                        Spacer()
                        Button("Cancel") { midi.cancelLearning() }
                    }
                }
                ForEach(MIDIAction.all, id: \.self) { action in
                    bindingRow(action)
                }
            }

            Section {
                Text("""
                Note On, Control Change (value 64 or above) and Program Change are \
                accepted. Clock, active sensing and sysex are ignored. Bindings are \
                stored by message rather than by device, so replugging the same \
                controller keeps working.
                """)
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
    }

    @ViewBuilder
    private func bindingRow(_ action: MIDIAction) -> some View {
        let binding = midi.binding(for: action)
        HStack {
            Text(action.displayName)
            Spacer()
            if let binding {
                Text(MIDIMessage(status: binding.status, channel: binding.channel,
                                 data1: binding.data1, data2: 127).displayDescription)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Toggle("Any ch", isOn: Binding(
                    get: { binding.channel == MIDIBinding.anyChannel },
                    set: { midi.setAnyChannel($0, forBindingID: binding.id) }))
                    .toggleStyle(.checkbox)
                    .help("Some controllers change channel per bank")
                Button {
                    midi.removeBinding(id: binding.id)
                } label: { Image(systemName: "delete.left") }
                .buttonStyle(.borderless)
            } else {
                Text("—").foregroundStyle(.secondary)
            }
            Button("Learn") { midi.beginLearning(action) }
                .disabled(midi.learningAction != nil)
        }
    }
}
