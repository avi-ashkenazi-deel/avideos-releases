import SwiftUI

/// The session's bespoke settings — its three quick-rest buttons. Reached by
/// editing the "Free workout" row (like editing a timer). The values are shared
/// with the Apple Watch.
struct SessionSettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Activity type", selection: $settings.sessionWorkoutKind) {
                        ForEach(WorkoutKind.allCases) { kind in
                            Label(kind.name, systemImage: kind.symbol).tag(kind)
                        }
                    }
                } header: {
                    Text("Workout")
                } footer: {
                    Text("How the Apple Watch logs a free workout to Fitness, and the icon shown for it.")
                }

                Section {
                    ForEach(settings.restDurations.indices, id: \.self) { i in
                        Stepper("Rest \(i + 1): \(restLabel(settings.restDurations[i]))",
                                value: restBinding(i), in: 5...600, step: 5)
                    }
                } header: {
                    Text("Rest buttons")
                } footer: {
                    Text("The three quick-rest buttons shown during a session — on this iPhone and your Apple Watch.")
                }
            }
            .navigationTitle("Free workout")
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
