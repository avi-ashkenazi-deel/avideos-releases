import SwiftUI

/// App settings. Today: the three quick-rest durations used in a session, shared
/// with the Apple Watch.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(settings.restDurations.indices, id: \.self) { i in
                        Stepper("Rest \(i + 1): \(restLabel(settings.restDurations[i]))",
                                value: restBinding(i), in: 5...600, step: 5)
                    }
                } header: {
                    Text("Session rest buttons")
                } footer: {
                    Text("The three quick-rest buttons shown during a session — on this iPhone and your Apple Watch.")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func restBinding(_ i: Int) -> Binding<TimeInterval> {
        Binding(
            get: { settings.restDurations[i] },
            set: { settings.restDurations[i] = $0 }
        )
    }
}
