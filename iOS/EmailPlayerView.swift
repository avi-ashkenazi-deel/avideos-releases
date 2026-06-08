import SwiftUI
import UIKit

/// The reading + player surface: an optional voice warning, the live-highlighted
/// transcript, and the transport controls. It drives the single, app-wide
/// `EmailPlayerViewModel` from the environment so playback continues no matter
/// where you navigate.
///
/// This view carries *no* presentation chrome of its own (no `NavigationStack`,
/// no collapse button), so it can be reused two ways: wrapped by `NowPlayingView`
/// as the iPhone full-screen sheet, and dropped straight into the iPad split
/// view's detail column. Callers supply the surrounding navigation.
///
/// If you open an email while a *different* one is still playing, this shows the
/// new one as a preview (the old keeps playing) with a "Play this email" button.
struct PlayerDetailContent: View {
    @EnvironmentObject private var player: EmailPlayerViewModel
    @ObservedObject private var settings = AppSettings.shared

    @State private var highlightToAnnotate: Highlight?
    @State private var showCompletion = false
    @State private var dismissedVoiceWarning = false

    var body: some View {
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
        case .image:
            // Images are intentionally not shown in the reader — we're a
            // listening app, so the transcript stays text-only. The player still
            // handles image blocks for audio per the Settings "images" behavior
            // (skip silently / pause to digest); they just aren't drawn here.
            EmptyView()
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

/// iPhone full-screen "Now Playing": the shared reading/player surface plus a
/// collapse button that hides it back down to the mini-player. Presented over the
/// app, so playback continues underneath when collapsed. (On iPad the same
/// `PlayerDetailContent` lives permanently in the split view's detail column, so
/// there's nothing to collapse and this wrapper isn't used.)
struct NowPlayingView: View {
    @EnvironmentObject private var player: EmailPlayerViewModel

    var body: some View {
        NavigationStack {
            PlayerDetailContent()
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
