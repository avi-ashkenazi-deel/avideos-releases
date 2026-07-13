import SwiftUI

/// The master output switch: Both / Voice / Vibrate. This is the one-tap control
/// you flip walking on stage (vibrate) or into the gym (voice). Bound straight to
/// `AppSettings`, so it persists and syncs to the watch.
struct OutputModePicker: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Picker("Output", selection: $settings.outputMode) {
            ForEach(OutputMode.allCases) { mode in
                Label(mode.displayName, systemImage: mode.systemImage).tag(mode)
            }
        }
        .pickerStyle(.segmented)
    }
}
