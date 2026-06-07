import SwiftUI

/// Transport controls under the transcript: progress, a tappable speed chip,
/// skip, play/pause, and highlight.
struct PlayerControlsView: View {
    @ObservedObject var viewModel: EmailPlayerViewModel
    @ObservedObject private var settings = AppSettings.shared
    let onHighlight: () -> Void

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]

    var body: some View {
        VStack(spacing: 14) {
            ProgressView(value: viewModel.progress)
                .tint(.accentColor)

            HStack {
                speedChip
                    .frame(width: 64, alignment: .leading)

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
        }
    }

    /// Compact speed control: shows the current speed; tap for slower/faster.
    private var speedChip: some View {
        Menu {
            ForEach(speeds, id: \.self) { speed in
                Button { viewModel.setSpeed(speed) } label: {
                    if abs(settings.speed - speed) < 0.001 {
                        Label(speedLabel(speed), systemImage: "checkmark")
                    } else {
                        Text(speedLabel(speed))
                    }
                }
            }
        } label: {
            Text(speedLabel(settings.speed))
                .font(.subheadline.monospacedDigit().weight(.bold))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(Color.secondary.opacity(0.15)))
        }
        .tint(.primary)
    }

    private func speedLabel(_ speed: Double) -> String {
        // Round to the nearest 0.05 for a tidy label (e.g. 1×, 1.5×, 1.75×).
        let rounded = (speed * 20).rounded() / 20
        return String(format: "%g×", rounded)
    }
}
