import SwiftUI
import UIKit

/// The watch is a live remote for the phone's player. It mirrors what the phone
/// is reading (artwork, show, subject, progress, time left) and drives transport
/// from the wrist — play/pause, skip, speed, highlight — over WatchConnectivity.
///
/// Layout, top → bottom (modeled on a podcast remote):
///   1. progress bar + "time left"
///   2. artwork + show / subject
///   3. transport buttons (skip back · play/pause · skip forward)
///   4. speed (− value +) + highlight
struct WatchNowPlayingView: View {
    @ObservedObject private var bridge = WatchConnectivityBridge.shared
    @State private var showHighlightConfirmation = false

    /// Only treat the phone as "playing something" when it has real content.
    private var state: NowPlayingState? {
        guard let s = bridge.nowPlaying, s.hasContent else { return nil }
        return s
    }

    var body: some View {
        Group {
            if let state {
                remote(state)
            } else {
                idle
            }
        }
        .overlay(alignment: .top) {
            if showHighlightConfirmation { highlightToast }
        }
    }

    // MARK: - Remote

    private func remote(_ state: NowPlayingState) -> some View {
        VStack(spacing: 8) {
            // 1 — progress + time remaining
            VStack(spacing: 3) {
                ProgressView(value: state.progress.clampedUnit).tint(.orange)
                Text("\(state.minutesRemaining)M LEFT")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }

            // 2 — artwork + show / subject
            HStack(spacing: 8) {
                WatchArtwork(address: state.senderAddress)
                    .frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.sender.uppercased())
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(state.subject)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            // 3 — transport
            HStack(spacing: 20) {
                transportButton("backward.fill") { bridge.send(command: .previousSentence) }
                transportButton(state.isPlaying ? "pause.fill" : "play.fill", large: true) {
                    bridge.send(command: state.isPlaying ? .pause : .play)
                }
                transportButton("forward.fill") { bridge.send(command: .nextSentence) }
            }
            .padding(.vertical, 2)

            // 4 — speed + highlight
            HStack(spacing: 8) {
                Button { changeSpeed(by: -0.25, from: state.speed) } label: {
                    Image(systemName: "minus")
                }
                Text(speedLabel(state.speed))
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                    .frame(minWidth: 40)
                Button { changeSpeed(by: 0.25, from: state.speed) } label: {
                    Image(systemName: "plus")
                }
                Button {
                    bridge.send(command: .highlight)
                    flashHighlight()
                } label: {
                    Image(systemName: "highlighter")
                }
                .tint(.yellow)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 6)
    }

    private func transportButton(_ symbol: String, large: Bool = false,
                                 action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(large ? .title : .title3)
                .frame(width: large ? 46 : 36, height: large ? 46 : 36)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Idle

    private var idle: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone.radiowaves.left.and.right")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Nothing playing")
                .font(.headline)
            Text("Start reading an email on your iPhone, then control it from here.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var highlightToast: some View {
        Text("Highlighted")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(.yellow, in: Capsule())
            .foregroundStyle(.black)
            .task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                showHighlightConfirmation = false
            }
    }

    // MARK: - Actions

    private func changeSpeed(by delta: Double, from current: Double) {
        let next = ((current + delta) * 100).rounded() / 100
        bridge.send(speed: min(max(next, 0.5), 2.5))
    }

    private func flashHighlight() {
        showHighlightConfirmation = true
    }

    private func speedLabel(_ speed: Double) -> String {
        // 1.0 → "1×", 1.25 → "1.25×", 1.5 → "1.5×" (trim trailing zeros)
        if speed == speed.rounded() { return "\(Int(speed))×" }
        var s = String(format: "%.2f", speed)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return "\(s)×"
    }
}

private extension Double {
    /// Clamp to 0...1 so a stale snapshot can't push the progress bar out of range.
    var clampedUnit: Double { min(max(self, 0), 1) }
}

/// Small circular artwork for the watch remote: tries the same logo/avatar
/// sources the phone uses, falling back to an envelope glyph. No image → glyph.
private struct WatchArtwork: View {
    let address: String
    @StateObject private var loader = ArtworkLoader()

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    Circle().fill(Color.gray.opacity(0.25))
                    Image(systemName: "envelope.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .task(id: address) { await loader.load(address: address) }
    }
}

@MainActor
private final class ArtworkLoader: ObservableObject {
    @Published private(set) var image: UIImage?
    private var loaded: String?

    func load(address: String) async {
        let key = address.lowercased()
        guard !key.isEmpty, key != loaded else { return }
        loaded = key
        image = nil
        for url in SenderImage.candidateURLs(forAddress: key) {
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let img = UIImage(data: data) else { continue }
            image = img
            return
        }
    }
}
