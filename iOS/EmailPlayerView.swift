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

    /// The article opened in the in-app browser sheet (nil = closed).
    @State private var browserLink: BrowserLink?

    private struct BrowserLink: Identifiable {
        let id = UUID()
        let url: URL
    }

    @State private var highlightToAnnotate: Highlight?
    @State private var showCompletion = false
    @State private var dismissedVoiceWarning = false
    @State private var showLinks = false
    /// Measured height of the floating transport panel, used as the transcript's
    /// bottom inset so the last sentence clears it.
    @State private var controlsHeight: CGFloat = 140

    /// Links from whatever's on screen (a staged preview takes precedence).
    private var currentLinks: [EmailLink] {
        player.staged?.links ?? player.parsed?.links ?? []
    }

    /// The feed item's own web page, so the reader can offer "open the full
    /// article in the browser". Feed emails stash the item's link in the sender
    /// address; nil for regular mail (no web page to open).
    private var articleURL: URL? {
        guard let email = player.staged?.email ?? player.parsed?.email,
              email.id.hasPrefix("rss-"),
              let url = URL(string: email.from.address),
              url.scheme?.hasPrefix("http") == true else { return nil }
        return url
    }

    // The iPad reading pane is much wider than an iPhone, so the same point size
    // looks small there. Scale the reading text up on iPad (every size, including
    // Extra Large) while leaving the iPhone sizes untouched.
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }
    private var readingScale: CGFloat { isPad ? 1.4 : 1 }
    private var bodyFontSize: CGFloat { settings.readingTextSize.bodyPointSize * readingScale }
    private var titleFontSize: CGFloat { settings.readingTextSize.titlePointSize * readingScale }

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
            if let articleURL {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { browserLink = BrowserLink(url: articleURL) } label: {
                        Image(systemName: "safari")
                    }
                    .accessibilityLabel("Open the full article in the browser")
                }
            }
            if !currentLinks.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showLinks = true } label: {
                        Image(systemName: "link")
                    }
                    .accessibilityLabel("Links in this email")
                }
            }
            if settings.pictureInPicture && ReaderPiPController.shared.isSupported {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { ReaderPiPController.shared.start() } label: {
                        Image(systemName: "pip.enter")
                    }
                }
            }
        }
        .sheet(isPresented: $showLinks) {
            NavigationStack { LinksListView(links: currentLinks) }
        }
        .sheet(item: $browserLink) { link in
            // In-app browser sliding up from the bottom. Large by default, but
            // draggable down to a half-height card (and swipe-down to close).
            SafariView(url: link.url)
                .ignoresSafeArea()
                .presentationDetents([.large, .medium])
                .presentationDragIndicator(.visible)
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
            if showCompletion && !player.celebrateFeedFinish { completionBanner }
        }
        .overlay {
            if player.celebrateFeedFinish { feedFinishedCelebration }
        }
        .onChange(of: player.celebrateFeedFinish) { _, celebrating in
            guard celebrating else { return }
            // The per-item "Finished" banner would double up with the celebration.
            showCompletion = false
            Task {
                try? await Task.sleep(nanoseconds: 2_800_000_000)
                player.celebrateFeedFinish = false
                // Drop back to the feed list (collapses the reader on iPhone;
                // clears the iPad detail pane) so all items are in view again.
                player.clear()
            }
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
                               date: email?.receivedAt,
                               emailID: email?.id ?? "",
                               blocks: player.blocks,
                               currentIndex: player.currentBlockIndex,
                               isActive: true)
                    // Clear the floating transport panel by its *measured* height
                    // (+ a margin), so the last sentence is never hidden behind it.
                    .padding(.bottom, controlsHeight + 24)
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
            .background(GeometryReader { geo in
                Color.clear.preference(key: ControlsHeightKey.self, value: geo.size.height)
            })
        }
        .onPreferenceChange(ControlsHeightKey.self) { controlsHeight = max($0, 96) }
    }

    // MARK: - Preview (staged) mode

    private func previewMode(_ staged: ParsedEmail) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                transcriptBody(subject: staged.email.subjectOrFallback,
                               date: staged.email.receivedAt,
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

    private func transcriptBody(subject: String, date: Date?, emailID: String, blocks: [ContentBlock],
                                currentIndex: Int?, isActive: Bool) -> some View {
        let layout = notedLayout(emailID: emailID, blocks: blocks)
        // Titles-only feed items carry a single body sentence that *is* the
        // headline (so it can be spoken). The subject heading already shows it,
        // so don't render it twice — just show the heading.
        let hideBody = blocks.count == 1
            && !blocks[0].isImage
            && blocks[0].spokenText.trimmingCharacters(in: .whitespacesAndNewlines)
                .caseInsensitiveCompare(subject.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
        let isRTLHeader = LanguageTools.isRightToLeft(subject)
        // Feed items show when they're from, under the headline — display only,
        // never spoken (it isn't part of the body blocks the engine reads).
        let dateLine: String? = {
            guard emailID.hasPrefix("rss-"), let date else { return nil }
            return date.formatted(date: .abbreviated, time: .shortened)
        }()
        return VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: isRTLHeader ? .trailing : .leading, spacing: 4) {
                Text(subject)
                    .font(.system(size: titleFontSize, weight: .bold))
                    .multilineTextAlignment(isRTLHeader ? .trailing : .leading)
                if let dateLine {
                    Text(dateLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: isRTLHeader ? .trailing : .leading)
            .padding(.bottom, 4)

            if !hideBody {
                ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                    blockView(block, index: index, currentIndex: currentIndex, isActive: isActive,
                              noted: layout[index] ?? NotedInfo())
                        .id(index)
                }
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
                         fontSize: bodyFontSize,
                         listDepth: sentence.listDepth,
                         bulletMarker: sentence.bulletMarker)
                .contentShape(Rectangle())
                .onTapGesture { if isActive { player.jump(toBlock: index) } }
                .contextMenu { skipMenu(for: sentence) }
        case .image(let image):
            ImageBlockView(image: image, isCurrent: isCurrent) {
                player.skipImage()
            }
            .onTapGesture { if isActive { player.jump(toBlock: index) } }
        }
    }

    /// Long-press menu on a sentence: teach the app to always skip this recurring
    /// line — for this sender (e.g. Substack's "Read in app") or for everyone.
    @ViewBuilder
    private func skipMenu(for sentence: Sentence) -> some View {
        if let from = player.parsed?.email.from ?? player.staged?.email.from {
            let domain = SkipRuleStore.domain(of: from.address)
            Button {
                SkipRuleStore.shared.add(phrase: sentence.text, senderDomain: domain, label: from.displayName)
                player.reapplySkipRules()
            } label: {
                Label("Always skip this from \(from.displayName)", systemImage: "speaker.slash")
            }
            Button {
                SkipRuleStore.shared.add(phrase: sentence.text, senderDomain: "", label: from.displayName)
                player.reapplySkipRules()
            } label: {
                Label("Always skip this from anyone", systemImage: "speaker.slash.fill")
            }
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

    /// Full-screen celebration when the listener finishes every unread feed item:
    /// confetti over a "caught up" card, shown briefly before dropping back to the
    /// feed list.
    private var feedFinishedCelebration: some View {
        ZStack {
            Color(.systemBackground).opacity(0.75).ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(.green)
                Text("You're all caught up")
                    .font(.title2.bold())
                Text("You've listened to everything in your feeds.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(28)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
            .padding(40)
            ConfettiView()
        }
        .transition(.opacity)
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

/// Reports the floating transport panel's height up to the transcript so it can
/// reserve exactly that much bottom space.
private struct ControlsHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 140
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
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
    var listDepth: Int = 0
    var bulletMarker: String = ""

    /// Must match the transcript's `VStack` spacing so a run's fill bridges the
    /// gap to the next sentence exactly, with no seam and no overlap.
    private static let blockSpacing: CGFloat = 16
    private static let cornerRadius: CGFloat = 8

    private var isRTL: Bool { LanguageTools.isRightToLeft(text) }
    private var isNoted: Bool { notedPosition != .none }
    private var roundsTop: Bool { notedPosition == .single || notedPosition == .first }
    private var roundsBottom: Bool { notedPosition == .single || notedPosition == .last }
    private var bridgesToNext: Bool { notedPosition == .first || notedPosition == .middle }

    /// Extra leading inset per nesting level so nested bullets sit in from their
    /// parent. Level 1 isn't indented; each deeper level adds a step.
    private var listIndent: CGFloat { CGFloat(max(listDepth - 1, 0)) * 20 }

    var body: some View {
        sentenceRow
            .lineSpacing(5)
            .environment(\.layoutDirection, isRTL ? .rightToLeft : .leftToRight)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .padding(isRTL ? .trailing : .leading, listIndent)
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

    /// The sentence text, with a bullet/number in front when it's the start of a
    /// list item. The marker is its own `Text` so it never shifts the word-range
    /// underline, which indexes into the spoken `text`.
    @ViewBuilder
    private var sentenceRow: some View {
        if bulletMarker.isEmpty {
            Text(attributed)
                .font(.system(size: fontSize))
                .multilineTextAlignment(isRTL ? .trailing : .leading)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(bulletMarker)
                    .font(.system(size: fontSize))
                    .foregroundStyle(.secondary)
                Text(attributed)
                    .font(.system(size: fontSize))
                    .multilineTextAlignment(isRTL ? .trailing : .leading)
                    .frame(maxWidth: .infinity, alignment: isRTL ? .trailing : .leading)
            }
        }
    }

    /// A noted run renders as one continuous yellow shape: only the run's ends are
    /// rounded, and every sentence but the last reaches down into the inter-sentence
    /// gap to meet the next one. The sentence being read gets no background wash —
    /// the recolored spoken word marks the reading position instead.
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
        }
    }

    private var attributed: AttributedString {
        var string = AttributedString(text)
        guard isCurrent, let wordRange,
              let swiftRange = Range(wordRange, in: text),
              let attrRange = Range(swiftRange, in: string) else {
            return string
        }
        // Just recolor the word being read — no bold (which would nudge the layout
        // as each word thickens and thins).
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
        // Show the card whenever there's a URL we can try to load. We intentionally
        // do NOT keep a "failed" flag: the old code latched failure from inside the
        // AsyncImage builder (mutating state during a view update), and on iPad the
        // split-view's extra layout passes cancel the in-flight load — that
        // cancellation counted as a failure and permanently collapsed *every* image.
        if let url = image.remoteURL {
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
                    // Genuine fetch failure (rare — decorative images and tracking
                    // pixels are filtered out upstream). Show a muted placeholder
                    // instead of latching state, so a re-render can retry.
                    failurePlaceholder
                case .empty:
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                @unknown default:
                    failurePlaceholder
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

    private var failurePlaceholder: some View {
        HStack(spacing: 6) {
            Image(systemName: "photo")
            Text((image.altText?.isEmpty == false ? image.altText : nil) ?? "Image unavailable")
                .lineLimit(2)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 80)
    }
}
