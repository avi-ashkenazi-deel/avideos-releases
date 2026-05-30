import SwiftUI

/// Watch player: shows the current sentence (or image notice) and a compact set
/// of controls — play/pause, skip, and highlight. Highlights are saved locally
/// and relayed to the phone.
struct WatchPlayerView: View {
    @StateObject private var viewModel = EmailPlayerViewModel(mailService: MockMailService())
    let email: Email

    @State private var showHighlightConfirmation = false

    var body: some View {
        VStack(spacing: 10) {
            ScrollView {
                if case .image(let image)? = viewModel.currentBlock {
                    VStack(spacing: 6) {
                        if let url = image.remoteURL {
                            AsyncImage(url: url) { img in
                                img.resizable().scaledToFit()
                            } placeholder: {
                                Image(systemName: "photo").font(.title)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        Text(image.spokenDescription)
                            .font(.footnote)
                            .multilineTextAlignment(.center)
                        Button { viewModel.skipImage() } label: {
                            Label("Skip image", systemImage: "forward.end.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    Text(currentText)
                        .font(.body)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
            }

            ProgressView(value: viewModel.progress).tint(.accentColor)

            HStack(spacing: 14) {
                Button { viewModel.previousSentence() } label: {
                    Image(systemName: "backward.fill")
                }
                Button { viewModel.togglePlayPause() } label: {
                    Image(systemName: viewModel.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title3)
                }
                Button { viewModel.nextSentence() } label: {
                    Image(systemName: "forward.fill")
                }
                Button {
                    _ = viewModel.captureHighlight()
                    showHighlightConfirmation = true
                } label: {
                    Image(systemName: "highlighter")
                }
                .tint(.yellow)
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 6)
        .navigationTitle(email.from.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            viewModel.onHighlightCaptured = { highlight in
                #if canImport(WatchConnectivity)
                WatchConnectivityBridge.shared.send(highlight: highlight)
                #endif
            }
            await viewModel.load(email: email)
        }
        .onDisappear { viewModel.stop() }
        .overlay(alignment: .top) {
            if showHighlightConfirmation {
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
        }
    }

    private var currentText: String {
        guard let block = viewModel.currentBlock else { return email.subjectOrFallback }
        switch block {
        case .sentence(let s): return s.text
        case .image(let i): return i.spokenDescription
        }
    }
}
