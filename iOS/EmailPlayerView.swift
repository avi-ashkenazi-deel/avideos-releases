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
    @ObservedObject private var highlightStore = HighlightStore.shared

    @State private var highlightToAnnotate: Highlight?
    @State private var showCompletion = false
    @State private var dismissedVoiceWarning = false

    var body: some View {
        VStack(spacing: 0) {
            voiceBanner
            modeContent
        }
        .background(PiPHostView().frame(width: 2, height: 2).opacity(0.02).allowsHitTesting(false))
        .onChange(of: player.parsed?.email.id) { _, _ in
            dismissedVoiceWarning = false
            renderPiP()
        }
        .navigationTitle(player.staged?.email.from.displayName
                         ?? player.parsed?.email.from.displayName ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if settings.pictureInPicture && ReaderPiPController.shared.isSupported {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { ReaderPiPController.shared.start() } label: {
                        Image(systemName: "pip.enter")
                    }
                }
            }
        }
        .onAppear {
            player.onHighlightCaptured = { highlight in highlightToAnnotate = highlight }
            updateIdleTimer()
            configurePiP()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            ReaderPiPController.shared.teardown()
        }
        .onChange(of: player.isPlaying) { _, _ in
            updateIdleTimer()
            ReaderPiPController.shared.playbackStateChanged()
        }
        .onChange(of: player.currentBlockIndex) { _, _ in renderPiP() }
        .onChange(of: settings.keepScreenAwake) { _, _ in updateIdleTimer() }
        .onChange(of: settings.pictureInPicture) { _, _ in updatePiPEnabled() }
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

    /// The dismissible voice-quality banners, kept out of `body` so the
    /// type-checker handles each conditional branch separately.
    @ViewBuilder
    private var voiceBanner: some View {
        if let language = player.missingVoiceLanguage, !dismissedVoiceWarning {
            voiceWarning(language)
        }
    }

    /// Preview / loading / active, split out of `body` for the same reason.
    @ViewBuilder
    private var modeContent: some View {
        if let staged = player.staged {
            previewMode(staged)
        } else if player.parsed == nil {
            Spacer()
            ProgressView("Opening…")
            Spacer()
        } else {
            activeMode
        }
    }

    /// Hold the screen on while you're watching it read (like a video), per the
    /// "Keep screen awake" setting. Released when paused or the view goes away.
    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = settings.keepScreenAwake && player.isPlaying
    }

    // MARK: - Picture in Picture

    /// Point PiP's transport at the shared player and enable it per the setting.
    private func configurePiP() {
        let pip = ReaderPiPController.shared
        pip.isPlayingProvider = { [weak player] in player?.isPlaying ?? false }
        pip.onTogglePlay = { [weak player] in player?.togglePlayPause() }
        pip.onSkip = { [weak player] forward in
            forward ? player?.nextSentence() : player?.previousSentence()
        }
        updatePiPEnabled()
    }

    private func updatePiPEnabled() {
        let pip = ReaderPiPController.shared
        if settings.pictureInPicture {
            pip.setAutoStart(true)
            renderPiP()
        } else {
            pip.teardown()
        }
    }

    /// Push a fresh PiP frame showing what's being read right now.
    private func renderPiP() {
        guard settings.pictureInPicture else { return }
        let header = player.parsed?.email.from.displayName ?? ""
        let sentence: String
        switch player.currentBlock {
        case .sentence(let s)?: sentence = s.text
        case .image?:           sentence = "🖼 Image"
        case nil:               sentence = player.parsed?.email.subjectOrFallback ?? ""
        }
        ReaderPiPController.shared.render(header: header, sentence: sentence, progress: player.progress)
    }

    // MARK: - Active (playing) mode

    private var activeMode: some View {
        let email = player.parsed?.email
        return ScrollViewReader { proxy in
            ScrollView {
                transcriptBody(subject: email?.subjectOrFallback ?? "",
                               emailID: email?.id ?? "",
                               blocks: player.blocks,
                               currentIndex: player.currentBlockIndex,
                               isActive: true)
                    // Room so the last lines clear the floating transport panel.
                    .padding(.bottom, 96)
            }
            .onChange(of: player.currentBlockIndex) { _, index in
                withAnimation(.easeInOut) { proxy.scrollTo(index, anchor: .center) }
            }
        }
        // The transport floats over the transcript as a Liquid Glass panel rather
        // than a bar pinned to the bottom edge.
        .overlay(alignment: .bottom) {
            PlayerControlsView(viewModel: player) {
                _ = player.captureHighlight()
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .floatingGlass()
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
        }
    }

    // MARK: - Preview (staged) mode

    private func previewMode(_ staged: ParsedEmail) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                transcriptBody(subject: staged.email.subjectOrFallback,
                               emailID: staged.email.id,
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

    private func transcriptBody(subject: String, emailID: String, blocks: [ContentBlock],
                                currentIndex: Int?, isActive: Bool) -> some View {
        let layout = notedLayout(emailID: emailID, blocks: blocks)
        return VStack(alignment: .leading, spacing: 16) {
            Text(subject)
                .font(.system(size: settings.readingTextSize.titlePointSize, weight: .bold))
                .multilineTextAlignment(LanguageTools.isRightToLeft(subject) ? .trailing : .leading)
                .frame(maxWidth: .infinity,
                       alignment: LanguageTools.isRightToLeft(subject) ? .trailing : .leading)
                .padding(.bottom, 4)

            ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                blockView(block, index: index, currentIndex: currentIndex, isActive: isActive,
                          noted: layout[index] ?? NotedInfo())
                    .id(index)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Maps each sentence block to how it should render its saved-highlight state.
    /// A block counts as "noted" when its spoken text appears in a highlight's
    /// captured passage, or it is the highlight's anchor block. Consecutive noted
    /// blocks are then grouped into runs so a passage spanning several sentences
    /// reads as one continuous highlight with a single marker — not several boxes.
    private func notedLayout(emailID: String, blocks: [ContentBlock]) -> [Int: NotedInfo] {
        guard !emailID.isEmpty else { return [:] }
        let saved = highlightStore.highlights(forEmail: emailID)
        guard !saved.isEmpty else { return [:] }

        var highlighted = Set<Int>(), withNote = Set<Int>()
        for (index, block) in blocks.enumerated() {
            guard case .sentence = block else { continue }
            let text = block.spokenText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 4 else { continue }
            for h in saved where (index == h.blockIndex && h.blockIndex > 0) || h.capturedText.contains(text) {
                highlighted.insert(index)
                if !h.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    withNote.insert(index)
                }
            }
        }
        guard !highlighted.isEmpty else { return [:] }

        var layout = [Int: NotedInfo]()
        let sorted = highlighted.sorted()
        var i = 0
        while i < sorted.count {
            var j = i
            while j + 1 < sorted.count && sorted[j + 1] == sorted[j] + 1 { j += 1 }
            let run = Array(sorted[i...j])
            let runHasNote = run.contains { withNote.contains($0) }
            for (k, idx) in run.enumerated() {
                var info = NotedInfo()
                if run.count == 1 { info.position = .single }
                else if k == 0 { info.position = .first }
                else if k == run.count - 1 { info.position = .last }
                else { info.position = .middle }
                // One marker per run, on its first sentence.
                if info.position == .single || info.position == .first {
                    info.showMarker = true
                    info.markerIsNote = runHasNote
                }
                layout[idx] = info
            }
            i = j + 1
        }
        return layout
    }

    @ViewBuilder
    private func blockView(_ block: ContentBlock, index: Int,
                           currentIndex: Int?, isActive: Bool,
                           noted: NotedInfo) -> some View {
        let isCurrent = currentIndex == index
        switch block {
        case .sentence(let sentence):
            SentenceText(text: sentence.text,
                         isCurrent: isCurrent,
                         notedPosition: noted.position,
                         showMarker: noted.showMarker,
                         markerIsNote: noted.markerIsNote,
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

/// Where a sentence sits within a run of consecutive saved-highlight sentences,
/// so the run can be drawn as one continuous block instead of separate boxes.
private enum HighlightRunPosition { case none, single, first, middle, last }

/// Per-block highlight rendering info derived from saved highlights.
private struct NotedInfo {
    var position: HighlightRunPosition = .none
    var showMarker = false
    var markerIsNote = false
}

private struct SentenceText: View {
    let text: String
    let isCurrent: Bool
    var notedPosition: HighlightRunPosition = .none
    var showMarker: Bool = false
    var markerIsNote: Bool = false
    let wordRange: NSRange?
    var fontSize: CGFloat = 22

    /// Must match the transcript's `VStack` spacing so a run's fill bridges the
    /// gap to the next sentence exactly, with no seam and no overlap.
    private static let blockSpacing: CGFloat = 16
    private static let cornerRadius: CGFloat = 8

    private var isRTL: Bool { LanguageTools.isRightToLeft(text) }
    private var isNoted: Bool { notedPosition != .none }
    private var roundsTop: Bool { notedPosition == .single || notedPosition == .first }
    private var roundsBottom: Bool { notedPosition == .single || notedPosition == .last }
    private var bridgesToNext: Bool { notedPosition == .first || notedPosition == .middle }

    var body: some View {
        Text(attributed)
            .font(.system(size: fontSize))
            .lineSpacing(5)
            .multilineTextAlignment(isRTL ? .trailing : .leading)
            .environment(\.layoutDirection, isRTL ? .rightToLeft : .leftToRight)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: isRTL ? .trailing : .leading)
            .background(highlightBackground)
            // A lone noted sentence that's being read gets the "now reading" accent
            // as a ring; within a multi-sentence run the highlighted word suffices.
            .overlay {
                if isCurrent && notedPosition == .single {
                    RoundedRectangle(cornerRadius: Self.cornerRadius)
                        .strokeBorder(Color.accentColor, lineWidth: 2)
                }
            }
            // One marker for the whole highlight (on its first sentence), so a
            // passage spanning several sentences doesn't look like several notes.
            .overlay(alignment: isRTL ? .topLeading : .topTrailing) {
                if showMarker {
                    Image(systemName: markerIsNote ? "note.text" : "highlighter")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.orange)
                        .padding(5)
                }
            }
            .foregroundStyle(isCurrent || isNoted ? .primary : .secondary)
    }

    /// A noted run renders as one continuous yellow shape: only the run's ends are
    /// rounded, and every sentence but the last reaches down into the inter-sentence
    /// gap to meet the next one. A plain current sentence gets the accent wash.
    @ViewBuilder
    private var highlightBackground: some View {
        if isNoted {
            UnevenRoundedRectangle(
                topLeadingRadius: roundsTop ? Self.cornerRadius : 0,
                bottomLeadingRadius: roundsBottom ? Self.cornerRadius : 0,
                bottomTrailingRadius: roundsBottom ? Self.cornerRadius : 0,
                topTrailingRadius: roundsTop ? Self.cornerRadius : 0
            )
            .fill(Color.yellow.opacity(0.30))
            .padding(.bottom, bridgesToNext ? -Self.blockSpacing : 0)
        } else if isCurrent {
            RoundedRectangle(cornerRadius: Self.cornerRadius)
                .fill(Color.accentColor.opacity(0.15))
        }
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

    // Flips when the remote image fails to load, so we collapse the block rather
    // than leave an empty grey box behind.
    @State private var failed = false

    var body: some View {
        // Only show the card when there's an image we can actually display. No URL
        // or a failed fetch → render nothing at all (no empty placeholder).
        if let url = image.remoteURL, !failed {
            card(url: url)
        }
    }

    private func card(url: URL) -> some View {
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

            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFit()
                case .failure:
                    // Mark failed → the card collapses so there's no empty box.
                    // We deliberately don't touch playback here: the player still
                    // announces this image in audio (core behavior) regardless of
                    // whether its picture could be fetched.
                    Color.clear.frame(height: 0).onAppear { failed = true }
                default:
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
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
}
