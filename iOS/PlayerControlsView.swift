import SwiftUI

/// Transport controls under the transcript: progress, a tappable speed chip,
/// skip, play/pause, and highlight.
struct PlayerControlsView: View {
    @ObservedObject var viewModel: EmailPlayerViewModel
    @ObservedObject private var settings = AppSettings.shared
    let onHighlight: () -> Void

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]

    /// Live scrub position while dragging; otherwise tracks `viewModel.progress`.
    @State private var draftProgress: Double = 0
    @State private var isScrubbing = false

    var body: some View {
        VStack(spacing: 14) {
            VStack(spacing: 6) {
                ScrubBar(progress: $draftProgress) { editing in
                    isScrubbing = editing
                    if !editing { viewModel.seek(toTime: draftProgress * viewModel.duration) }
                }

                HStack {
                    Text(timeString(displayElapsed))
                    Spacer()
                    Text("-" + timeString(max(0, viewModel.duration - displayElapsed)))
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            .onAppear { draftProgress = viewModel.progress }
            .onChange(of: viewModel.progress) { _, new in
                if !isScrubbing { draftProgress = new }
            }

            HStack {
                speedChip
                    .frame(width: 76, alignment: .leading)

                Spacer()

                Button { viewModel.previousSentence() } label: {
                    Image(systemName: "backward.fill").font(.title2)
                }
                .disabled(!viewModel.canSkipBackwardSentence)

                Button { viewModel.togglePlayPause() } label: {
                    Image(systemName: viewModel.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 56))
                }

                Button { viewModel.nextSentence() } label: {
                    Image(systemName: "forward.fill").font(.title2)
                }
                .disabled(!viewModel.canSkipForwardSentence)

                Spacer()

                // Right cluster: jump to the next item (mark read + advance) and
                // capture a highlight. Fixed width matches the speed chip so the
                // play/pause group stays centred.
                HStack(spacing: 18) {
                    if viewModel.canSkipToNextItem {
                        Button { viewModel.skipToNextItem() } label: {
                            Image(systemName: "forward.end.fill").font(.title3)
                        }
                        .tint(.primary)
                        .accessibilityLabel("Next item")
                    }
                    Button(action: onHighlight) {
                        Image(systemName: "highlighter").font(.title2)
                    }
                    .tint(.primary)
                }
                .frame(width: 76, alignment: .trailing)
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

    /// Elapsed seconds to show — the scrub preview while dragging, else actual.
    private var displayElapsed: TimeInterval {
        isScrubbing ? draftProgress * viewModel.duration : viewModel.elapsed
    }

    private func timeString(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// A thin progress line you can scrub. The accent-coloured fill grows across the
/// track as playback advances (and follows your finger while dragging), so the
/// position is always visible — unlike the stock `Slider`, whose large thumb and
/// hairline track read as a single flat bar.
private struct ScrubBar: View {
    @Binding var progress: Double
    let onScrub: (Bool) -> Void

    private let trackHeight: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let fraction = min(max(progress, 0), 1)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.25))
                Capsule().fill(Color.accentColor)
                    .frame(width: width * fraction)
            }
            .frame(height: trackHeight)
            .frame(maxHeight: .infinity)          // centre the line in the touch area
            .contentShape(Rectangle())            // whole height is draggable
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        onScrub(true)
                        progress = min(max(value.location.x / width, 0), 1)
                    }
                    .onEnded { _ in onScrub(false) }
            )
        }
        .frame(height: 22)
    }
}
