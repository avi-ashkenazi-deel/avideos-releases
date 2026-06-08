import SwiftUI
import UIKit

/// The full-screen "Now Playing" reading view, presented over the app. It drives
/// the single, app-wide `EmailPlayerViewModel` from the environment, so playback
/// continues no matter where you navigate; collapsing just hides this view and
/// leaves the mini-player running at the bottom.
///
/// If you open an email while a *different* one is still playing, this shows the
/// new one as a preview (the old keeps playing) with a "Play this email" button.
struct NowPlayingView: View {
    @EnvironmentObject private var player: EmailPlayerViewModel
    @ObservedObject private var settings = AppSettings.shared

    @State private var highlightToAnnotate: Highlight?
    @State private var showCompletion = false
    @State private var dismissedVoiceWarning = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let language = player.missingVoiceLanguage, !dismissedVoiceWarning {
                    voiceWarning(language)
                }
                if let staged = player.staged {
                    previewMode(staged)
                } else if player.parsed == nil {
                    Spacer(); ProgressView("Opening…"); Spacer()
                } else {
                    activeMode
                }
            }
            .onChange(of: player.parsed?.email.id) { _, _ in dismissedVoiceWarning = false }
            .navigationTitle(player.staged?.email.from.displayName
                             ?? player.parsed?.email.from.displayName ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        // Abandoning a preview returns focus to what's playing.
                        if player.staged != nil { player.discardStaged() }
                        player.isExpanded = false
                    } label: {
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

    // MARK: - Active (playing) mode

    private var activeMode: some View {
        let email = player.parsed?.email
        return VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    transcriptBody(subject: email?.subjectOrFallback ?? "",
                                   blocks: player.blocks,
                                   currentIndex: player.currentBlockIndex,
                                   isActive: true)
                }
                .onChange(of: player.currentBlockIndex) { _, index in
                    withAnimation(.easeInOut) { proxy.scrollTo(index, anchor: .center) }
                }
            }
            Divider()
            PlayerControlsView(viewModel: player) {
                _ = player.captureHighlight()
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .background(.bar)
        }
    }

    // MARK: - Preview (staged) mode

    private func previewMode(_ staged: ParsedEmail) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                transcriptBody(subject: staged.email.subjectOrFallback,
                               blocks: staged.blocks,
                               currentIndex: nil,
                               isActive: false)
            }
            Divider()
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Still playing")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(player.parsed?.email.from.displayName ?? "")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                Spacer()
                Button { player.playStaged() } label: {
                    Label("Play this email", systemImage: "play.fill")
                        .fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .background(.bar)
        }
    }

    // MARK: - Transcript

    private func transcriptBody(subject: String, blocks: [ContentBlock],
                                currentIndex: Int?, isActive: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(subject)
                .font(.system(size: settings.readingTextSize.titlePointSize, weight: .bold))
                .multilineTextAlignment(LanguageTools.isRightToLeft(subject) ? .trailing : .leading)
                .frame(maxWidth: .infinity,
                       alignment: LanguageTools.isRightToLeft(subject) ? .trailing : .leading)
                .padding(.bottom, 4)

            ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                blockView(block, index: index, currentIndex: currentIndex, isActive: isActive)
                    .id(index)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: ContentBlock, index: Int,
                           currentIndex: Int?, isActive: Bool) -> some View {
        let isCurrent = currentIndex == index
        switch block {
        case .sentence(let sentence):
            SentenceText(text: sentence.text,
                         isCurrent: isCurrent,
                         wordRange: isCurrent ? player.spokenWordRange : nil,
                         fontSize: settings.readingTextSize.bodyPointSize)
                .contentShape(Rectangle())
                .onTapGesture { if isActive { player.jump(toBlock: index) } }
        case .image(let image):
            ImageBlockView(image: image, isCurrent: isCurrent) {
                player.skipImage()
            }
            .onTapGesture { if isActive { player.jump(toBlock: index) } }
        }
    }

    private func voiceWarning(_ language: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "speaker.slash.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("No \(language) voice installed")
                    .font(.subheadline.weight(.semibold))
                Text("This email looks like it's in \(language), but there's no \(language) voice on this device, so it may not read correctly. Add one in Settings → Accessibility → Spoken Content → Voices.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 16) {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    Button("Dismiss") { dismissedVoiceWarning = true }
                        .foregroundStyle(.secondary)
                }
                .font(.caption.weight(.medium))
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.orange.opacity(0.12))
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
    var fontSize: CGFloat = 22

    private var isRTL: Bool { LanguageTools.isRightToLeft(text) }

    var body: some View {
        Text(attributed)
            .font(.system(size: fontSize))
            .lineSpacing(5)
            .multilineTextAlignment(isRTL ? .trailing : .leading)
            .environment(\.layoutDirection, isRTL ? .rightToLeft : .leftToRight)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: isRTL ? .trailing : .leading)
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
