import SwiftUI

/// Transport controls under the transcript: progress, play/pause, skip,
/// highlight, and a speed slider.
struct PlayerControlsView: View {
    @ObservedObject var viewModel: EmailPlayerViewModel
    @EnvironmentObject private var appState: AppState
    let onHighlight: () -> Void

    /// Live slider value; applied to the player when the drag ends so we don't
    /// restart the current sentence on every tick.
    @State private var draftSpeed: Double = 1.0

    var body: some View {
        VStack(spacing: 14) {
            ProgressView(value: viewModel.progress)
                .tint(.accentColor)

            HStack {
                Text(speedLabel(draftSpeed))
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .frame(width: 56, alignment: .leading)

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
                .tint(.primary)
            }

            HStack(spacing: 10) {
                Image(systemName: "tortoise.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Slider(value: $draftSpeed, in: 0.5...2.5) { editing in
                    if !editing { viewModel.setSpeed(draftSpeed) }
                }
                .tint(.accentColor)
                Image(systemName: "hare.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear { draftSpeed = appState.settings.speed }
        .onChange(of: appState.settings.speed) { _, newValue in
            if abs(draftSpeed - newValue) > 0.001 { draftSpeed = newValue }
        }
    }

    private func speedLabel(_ speed: Double) -> String {
        // Round to the nearest 0.05 for a tidy label (e.g. 1×, 1.5×, 1.75×).
        let rounded = (speed * 20).rounded() / 20
        return String(format: "%g×", rounded)
    }
}
