import SwiftUI

/// The full-screen "Now Playing" reading view, presented over the app. It drives
/// the single, app-wide `EmailPlayerViewModel` from the environment, so playback
/// continues no matter where you navigate; collapsing just hides this view and
/// leaves the mini-player running at the bottom.
struct NowPlayingView: View {
    @EnvironmentObject private var player: EmailPlayerViewModel

    @State private var highlightToAnnotate: Highlight?
    @State private var showCompletion = false

    private var displayEmail: Email? { player.parsed?.email }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if player.parsed == nil {
                    Spacer()
                    ProgressView("Opening…")
                    Spacer()
                } else {
                    transcript
                }
                Divider()
                PlayerControlsView(viewModel: player) {
                    _ = player.captureHighlight()
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
                .background(.bar)
            }
            .navigationTitle(displayEmail?.from.displayName ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { player.isExpanded = false } label: {
                        Image(systemName: "chevron.down")
                    }
                }
            }
            .onAppear {
                player.onHighlightCaptured = { highlight in highlightToAnnotate = highlight }
            }
            .onChange(of: player.isComplete) { _, complete in
                if complete { showCompletion = true }
            }
            .sheet(item: $highlightToAnnotate) { highlight in
                NavigationStack { HighlightComposerView(highlight: highlight) }
            }
            .overlay(alignment: .top) {
                if showCompletion { completionBanner }
            }
            .alert("Playback problem", isPresented: .constant(player.errorMessage != nil)) {
                Button("OK") { player.errorMessage = nil }
            } message: {
                Text(player.errorMessage ?? "")
            }
        }
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(displayEmail?.subjectOrFallback ?? "")
                        .font(.title2.bold())
                        .padding(.bottom, 4)

                    ForEach(Array(player.blocks.enumerated()), id: \.element.id) { index, block in
                        blockView(block, index: index)
                            .id(index)
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: player.currentBlockIndex) { _, index in
                withAnimation(.easeInOut) { proxy.scrollTo(index, anchor: .center) }
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: ContentBlock, index: Int) -> some View {
        let isCurrent = index == player.currentBlockIndex
        switch block {
        case .sentence(let sentence):
            SentenceText(text: sentence.text,
                         isCurrent: isCurrent,
                         wordRange: isCurrent ? player.spokenWordRange : nil)
                .contentShape(Rectangle())
                .onTapGesture { player.jump(toBlock: index) }
        case .image(let image):
            ImageBlockView(image: image, isCurrent: isCurrent) {
                player.skipImage()
            }
            .onTapGesture { player.jump(toBlock: index) }
        }
    }

    private var completionBanner: some View {
        Text("Finished — marked as read")
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(.green.opacity(0.9), in: Capsule())
            .foregroundStyle(.white)
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            .task {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                withAnimation { showCompletion = false }
            }
    }
}

// MARK: - Sentence

private struct SentenceText: View {
    let text: String
    let isCurrent: Bool
    let wordRange: NSRange?

    var body: some View {
        Text(attributed)
            .font(.title3)
            .lineSpacing(4)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isCurrent ? Color.accentColor.opacity(0.15) : .clear)
            )
            .foregroundStyle(isCurrent ? .primary : .secondary)
    }

    private var attributed: AttributedString {
        var string = AttributedString(text)
        guard isCurrent, let wordRange,
              let swiftRange = Range(wordRange, in: text),
              let attrRange = Range(swiftRange, in: string) else {
            return string
        }
        string[attrRange].inlinePresentationIntent = .stronglyEmphasized
        string[attrRange].foregroundColor = .accentColor
        return string
    }
}

// MARK: - Image block

private struct ImageBlockView: View {
    let image: InlineImage
    let isCurrent: Bool
    let onSkip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Image", systemImage: "photo")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if isCurrent {
                    Button(action: onSkip) {
                        Label("Skip", systemImage: "forward.end.fill")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
            }

            Group {
                if let url = image.remoteURL {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFit()
                        case .failure:
                            placeholder
                        default:
                            ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                        }
                    }
                } else {
                    placeholder
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))

            if let alt = image.altText, !alt.isEmpty {
                Text(alt).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(isCurrent ? Color.accentColor.opacity(0.12) : Color.gray.opacity(0.08))
        )
    }

    private var placeholder: some View {
        ZStack {
            Rectangle().fill(.gray.opacity(0.15))
            Image(systemName: "photo")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 140)
    }
}
