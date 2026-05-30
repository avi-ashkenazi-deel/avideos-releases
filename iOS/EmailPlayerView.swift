import SwiftUI

/// The reading screen: the email's sentences (with images inline), and the
/// player controls underneath. Press play to listen; the active sentence
/// highlights and scrolls into view. Highlight the last 10 seconds with the
/// button, an AirPods press, or the watch.
struct EmailPlayerView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel = EmailPlayerViewModel(mailService: MockMailService())

    let email: Email
    let onMarkedRead: (String) -> Void

    @State private var highlightToAnnotate: Highlight?
    @State private var showCompletion = false

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider()
            PlayerControlsView(viewModel: viewModel) {
                _ = viewModel.captureHighlight()
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .background(.bar)
        }
        .navigationTitle(email.from.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            viewModel.configure(appState.mailService)
            viewModel.onMarkedRead = onMarkedRead
            viewModel.onHighlightCaptured = { highlight in highlightToAnnotate = highlight }
            await viewModel.load(email: email)
        }
        .onAppear { bindControls() }
        .onDisappear { viewModel.unbindRemoteCommands() }
        .onChange(of: viewModel.isComplete) { _, complete in
            if complete { showCompletion = true }
        }
        .sheet(item: $highlightToAnnotate) { highlight in
            NavigationStack { HighlightComposerView(highlight: highlight) }
        }
        .overlay(alignment: .top) {
            if showCompletion { completionBanner }
        }
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(email.subjectOrFallback)
                        .font(.title2.bold())
                        .padding(.bottom, 4)

                    ForEach(Array(viewModel.blocks.enumerated()), id: \.element.id) { index, block in
                        blockView(block, index: index)
                            .id(index)
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: viewModel.currentBlockIndex) { _, index in
                withAnimation(.easeInOut) { proxy.scrollTo(index, anchor: .center) }
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: ContentBlock, index: Int) -> some View {
        let isCurrent = index == viewModel.currentBlockIndex
        switch block {
        case .sentence(let sentence):
            SentenceText(text: sentence.text,
                         isCurrent: isCurrent,
                         wordRange: isCurrent ? viewModel.spokenWordRange : nil)
                .contentShape(Rectangle())
                .onTapGesture { viewModel.jump(toBlock: index) }
        case .image(let image):
            ImageBlockView(image: image, isCurrent: isCurrent)
                .onTapGesture { viewModel.jump(toBlock: index) }
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

    private func bindControls() {
        viewModel.bindRemoteCommands(airPodsHighlight: appState.settings.airPodsHighlightEnabled)
        #if canImport(WatchConnectivity)
        WatchConnectivityBridge.shared.onCommand = { command in
            switch command {
            case .play: viewModel.play()
            case .pause: viewModel.pause()
            case .nextSentence: viewModel.nextSentence()
            case .previousSentence: viewModel.previousSentence()
            case .highlight: _ = viewModel.captureHighlight()
            }
        }
        #endif
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Image", systemImage: "photo")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

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
