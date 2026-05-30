import SwiftUI

/// Transport controls under the transcript: progress, play/pause, skip,
/// highlight, speed, and remove-silence.
struct PlayerControlsView: View {
    @ObservedObject var viewModel: EmailPlayerViewModel
    @EnvironmentObject private var appState: AppState
    let onHighlight: () -> Void

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

    var body: some View {
        VStack(spacing: 14) {
            ProgressView(value: viewModel.progress)
                .tint(.accentColor)

            HStack {
                Menu {
                    ForEach(speeds, id: \.self) { speed in
                        Button {
                            viewModel.setSpeed(speed)
                        } label: {
                            Label(speedLabel(speed),
                                  systemImage: appState.settings.speed == speed ? "checkmark" : "")
                        }
                    }
                } label: {
                    Text(speedLabel(appState.settings.speed))
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                        .frame(width: 52)
                }

                Spacer()

                Button { viewModel.previousSentence() } label: {
                    Image(systemName: "backward.fill").font(.title2)
                }

                Button { viewModel.togglePlayPause() } label: {
                    Image(systemName: viewModel.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 56))
                }

                Button { viewModel.nextSentence() } label: {
                    Image(systemName: "forward.fill").font(.title2)
                }

                Spacer()

                Button(action: onHighlight) {
                    Image(systemName: "highlighter").font(.title2)
                }
                .tint(.yellow)
            }

            Toggle(isOn: Binding(
                get: { appState.settings.removeSilence },
                set: { appState.settings.removeSilence = $0 }
            )) {
                Label("Remove silence", systemImage: "waveform.path")
                    .font(.footnote)
            }
            .toggleStyle(.button)
            .controlSize(.small)
        }
    }

    private func speedLabel(_ speed: Double) -> String {
        let trimmed = speed == speed.rounded() ? String(format: "%.0f", speed) : String(format: "%.2g", speed)
        return "\(trimmed)×"
    }
}
