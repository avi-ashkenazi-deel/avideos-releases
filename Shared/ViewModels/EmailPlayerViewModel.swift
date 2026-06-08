import Foundation
import Combine

/// Drives playback of a single email: speaks it block by block (via whichever
/// `SpeechEngine` is configured), handles images per the user's preference,
/// tracks position for highlighting, and marks the message read when it finishes.
@MainActor
final class EmailPlayerViewModel: ObservableObject {

    // Content
    @Published private(set) var parsed: ParsedEmail?
    @Published private(set) var currentBlockIndex = 0

    // Transport state
    @Published private(set) var isPlaying = false
    @Published private(set) var isComplete = false
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    // Live word being spoken (for on-screen underline), valid for sentence blocks.
    @Published private(set) var spokenWordRange: NSRange?

    /// Set to a language's display name (e.g. "Hebrew") when the email is in a
    /// language that has no installed system voice, so the UI can prompt to add
    /// one. Nil when a voice is available (or ElevenLabs is in use).
    @Published var missingVoiceLanguage: String?

    // Elapsed playback seconds (advances only while speaking).
    @Published private(set) var elapsed: TimeInterval = 0

    /// Whether the full-screen Now Playing view is presented. The mini-player
    /// stays visible whenever `parsed != nil`.
    @Published var isExpanded = false

    /// An email opened for viewing while a *different* one is still playing. The
    /// listener sees it and can choose to play it (which makes it active) without
    /// interrupting current playback.
    @Published private(set) var staged: ParsedEmail?
    private var stagedConfig: StagedConfig?

    private struct StagedConfig {
        var onMarkedRead: ((String) -> Void)?
        var markReadOverride: ((String) -> Void)?
        var nextUnreadProvider: ((String) -> Email?)?
        var startBlock: Int?
    }

    /// Called after the email is marked read, so the inbox can update.
    var onMarkedRead: ((String) -> Void)?
    /// When set, used instead of the mail service to persist "read" — e.g. saved
    /// articles, which live in the local store rather than on a mail server.
    var markReadOverride: ((String) -> Void)?
    /// Called when a highlight is captured (e.g. via AirPods) so the UI can
    /// offer to add a note.
    var onHighlightCaptured: ((Highlight) -> Void)?
    /// Supplies the next unread email to auto-advance to after one finishes,
    /// given the id just completed. Set by the inbox; nil disables auto-advance.
    var nextUnreadProvider: ((String) -> Email?)?

    private var mailService: MailService
    private let settings: AppSettings
    private let highlights: HighlightStore
    private let progressStore: ListeningProgressStore
    private let analytics: AnalyticsStore

    private var engine: SpeechEngine
    /// Identifies the engine config in use, so we rebuild only when it changes.
    private var engineSignature = ""
    private let voiceRecorder = VoiceNoteRecorder()
    private let imageDescriber = ImageDescriber()

    private var hasStarted = false
    /// True when the current block has finished and we're idle on it (e.g.
    /// paused to digest an image), so the next Play advances past it.
    private var currentBlockSpoken = false
    private var timer: Timer?
    /// Bumped on every speak/stop so an in-flight async image description can tell
    /// it's stale (the listener moved on / switched email) and not speak.
    private var playToken = 0
    private var estimatedDuration: TimeInterval = 1
    /// Log of (blockIndex, elapsedAtStart) for the highlight lookback window.
    private var spokenLog: [(index: Int, start: TimeInterval)] = []
    private let remote = RemoteCommandController()

    init(mailService: MailService,
         settings: AppSettings = .shared,
         highlights: HighlightStore = .shared,
         progress: ListeningProgressStore = .shared,
         analytics: AnalyticsStore = .shared) {
        self.mailService = mailService
        self.settings = settings
        self.highlights = highlights
        self.progressStore = progress
        self.analytics = analytics
        self.engine = EmailPlayerViewModel.makeEngine(settings: settings)
        wire(engine)
        engineSignature = currentEngineSignature()
    }

    /// Rebind to the active backend (demo vs Google) once `AppState` knows it.
    func configure(_ service: MailService) {
        mailService = service
    }

    var blocks: [ContentBlock] { parsed?.blocks ?? [] }

    var currentBlock: ContentBlock? {
        blocks.indices.contains(currentBlockIndex) ? blocks[currentBlockIndex] : nil
    }

    /// True when the player is currently sitting on an image (e.g. paused to
    /// digest it). The UI/lock screen offers a "skip image" affordance then.
    var isOnImage: Bool { currentBlock?.isImage ?? false }

    /// 0...1 progress through the email, by block position.
    var progress: Double {
        guard !blocks.isEmpty else { return 0 }
        return Double(currentBlockIndex) / Double(max(blocks.count - 1, 1))
    }

    /// Estimated total listening time (seconds), for the scrubber + time labels.
    var duration: TimeInterval { max(estimatedDuration, 0.1) }

    // MARK: - Loading

    func load(email: Email, announce: Bool = false) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let full = try await mailService.fetchFullEmail(id: email.id)
            await apply(full, announce: announce)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Load already-fetched content (e.g. a cached saved article) without a
    /// network round-trip.
    func loadLocal(_ email: Email) async {
        isLoading = true
        defer { isLoading = false }
        await apply(email)
    }

    /// Open an item in the Now Playing view. If a *different* email is currently
    /// playing, the new one is shown as a preview (staged) and playback continues
    /// until the listener taps play; otherwise it loads and is ready immediately.
    func open(email: Email,
              isLocal: Bool,
              startBlock: Int? = nil,
              onMarkedRead: ((String) -> Void)? = nil,
              markReadOverride: ((String) -> Void)? = nil,
              nextUnreadProvider: ((String) -> Email?)? = nil) {
        isExpanded = true
        let config = StagedConfig(onMarkedRead: onMarkedRead,
                                  markReadOverride: markReadOverride,
                                  nextUnreadProvider: nextUnreadProvider,
                                  startBlock: startBlock)
        if isPlaying, parsed?.email.id != email.id {
            Task { await stage(email: email, isLocal: isLocal, config: config) }
        } else {
            discardStaged()
            self.onMarkedRead = onMarkedRead
            self.markReadOverride = markReadOverride
            self.nextUnreadProvider = nextUnreadProvider
            Task {
                if isLocal { await loadLocal(email) } else { await load(email: email) }
                if let startBlock { seek(toBlock: startBlock) } else { resumeIfAvailable() }
            }
        }
    }

    private func stage(email: Email, isLocal: Bool, config: StagedConfig) async {
        let full: Email
        if isLocal {
            full = email
        } else {
            do { full = try await mailService.fetchFullEmail(id: email.id) }
            catch { errorMessage = error.localizedDescription; return }
        }
        let parsed = await Task.detached(priority: .userInitiated) { EmailParser.parse(full) }.value
        staged = parsed
        stagedConfig = config
    }

    /// Commit the staged item: stop current playback, make it active, and play.
    func playStaged() {
        guard let stagedEmail = staged, let config = stagedConfig else { return }
        stop()
        onMarkedRead = config.onMarkedRead
        markReadOverride = config.markReadOverride
        nextUnreadProvider = config.nextUnreadProvider
        parsed = stagedEmail
        staged = nil
        stagedConfig = nil
        currentBlockIndex = 0
        isComplete = false
        hasStarted = false
        currentBlockSpoken = false
        elapsed = 0
        spokenLog = []
        estimatedDuration = Self.estimateDuration(stagedEmail, speed: settings.speed)
        ReadingTimeStore.shared.record(
            id: stagedEmail.email.id,
            minutes: ReadingTime.minutes(forText: stagedEmail.blocks.map(\.spokenText).joined(separator: " "))
        )
        checkVoiceAvailability(for: stagedEmail)
        if let startBlock = config.startBlock {
            currentBlockIndex = startBlock
            hasStarted = true
        } else {
            resumeIfAvailable()
        }
        play()
    }

    func discardStaged() {
        staged = nil
        stagedConfig = nil
    }

    /// Resume at the block the listener last reached, if any (and not finished).
    /// Positions without playing, so the transcript scrolls there and Play picks
    /// up from the spot. Called after `load` when not opening a highlight.
    func resumeIfAvailable() {
        guard let id = parsed?.email.id,
              let saved = progressStore.progress(for: id),
              !saved.isComplete, saved.blockIndex > 0,
              blocks.indices.contains(saved.blockIndex) else { return }
        seek(toBlock: saved.blockIndex)
    }

    /// Dismiss the mini-player and stop playback entirely.
    func clear() {
        stop()
        remote.clearNowPlaying()
        parsed = nil
        staged = nil
        stagedConfig = nil
        isExpanded = false
        elapsed = 0
        hasStarted = false
        isComplete = false
    }

    private func apply(_ email: Email, announce: Bool = false) async {
        // Stop whatever was playing before swapping in new content.
        stop()
        // Parse off the main thread: real email/article HTML can be large, and
        // the tokenizer pass would otherwise freeze the UI.
        var parsed = await Task.detached(priority: .userInitiated) {
            EmailParser.parse(email)
        }.value
        // On auto-advance, lead with a spoken header so the listener knows who
        // it's from and what it is before the body starts.
        if announce {
            let intro = ContentBlock.sentence(
                Sentence(blockIndex: 0, text: Self.announcement(for: parsed.email))
            )
            parsed = ParsedEmail(email: parsed.email, blocks: [intro] + parsed.blocks)
        }
        self.parsed = parsed
        // Cache an accurate reading-time estimate from the real text so the
        // inbox shows it for opened messages without a separate fetch.
        ReadingTimeStore.shared.record(
            id: parsed.email.id,
            minutes: ReadingTime.minutes(forText: parsed.blocks.map(\.spokenText).joined(separator: " "))
        )
        self.estimatedDuration = Self.estimateDuration(parsed, speed: settings.speed)
        self.currentBlockIndex = 0
        self.isComplete = false
        self.hasStarted = false
        self.currentBlockSpoken = false
        self.elapsed = 0
        self.spokenLog = []
        checkVoiceAvailability(for: parsed)
    }

    /// The email's dominant language code (e.g. "he"), detected once from a large
    /// sample so short blocks don't have to detect on their own.
    private var dominantLanguageCode: String?

    /// Detect the email's dominant language, hand it to the engine as a hint, and
    /// flag when there's no installed on-device voice for it so the UI can prompt
    /// to add one. Skipped when ElevenLabs (multilingual) is active.
    private func checkVoiceAvailability(for parsed: ParsedEmail) {
        missingVoiceLanguage = nil
        // Sample real spoken sentences (skip image placeholders) for detection.
        let sample = parsed.blocks
            .compactMap { if case .image = $0 { return nil } else { return $0.spokenText } }
            .prefix(80)
            .joined(separator: " ")
        let code = sample.count > 20 ? LanguageTools.languageCode(for: sample) : nil
        dominantLanguageCode = code
        engine.preferredLanguage = code

        guard !settings.elevenLabsActive, let code else { return }
        if SystemSpeechEngine.bestVoice(forLanguage: code) == nil {
            missingVoiceLanguage = Locale.current.localizedString(forLanguageCode: code) ?? code
        }
    }

    // MARK: - Transport

    func togglePlayPause() { isPlaying ? pause() : play() }

    func play() {
        guard parsed != nil, !isComplete else { return }
        if engine.isPaused {
            engine.resume()
            isPlaying = true
            startTimer()
            updateNowPlaying()
            return
        }
        if !hasStarted {
            hasStarted = true
            speakBlock(at: 0)
            return
        }
        // Speak the current block, unless we already finished it (e.g. stopped on
        // an image to digest it), in which case continue to the next one.
        speakBlock(at: currentBlockSpoken ? currentBlockIndex + 1 : currentBlockIndex)
    }

    func pause() {
        engine.pause()
        isPlaying = false
        stopTimer()
        updateNowPlaying()
        recordProgress()
    }

    func nextSentence() {
        guard parsed != nil, !isComplete else { return }
        hasStarted = true
        speakBlock(at: currentBlockIndex + 1)
    }

    func previousSentence() {
        guard parsed != nil else { return }
        hasStarted = true
        speakBlock(at: max(currentBlockIndex - 1, 0))
    }

    /// Skip past the current image to the next block.
    func skipImage() {
        guard isOnImage else { return }
        nextSentence()
    }

    func jump(toBlock index: Int) {
        guard blocks.indices.contains(index) else { return }
        hasStarted = true
        isComplete = false
        speakBlock(at: index)
    }

    /// Move to a block and wait there (no audio) — used when opening an email
    /// from a saved highlight, so the listener can press play to resume from
    /// the spot they bookmarked.
    func seek(toBlock index: Int) {
        guard blocks.indices.contains(index) else { return }
        stop()
        isComplete = false
        hasStarted = true
        currentBlockSpoken = false
        currentBlockIndex = index
        updateNowPlaying()
    }

    /// Seek to a playback position (seconds), from the lock-screen scrubber.
    /// We read by sentence, so map the position to the nearest block.
    func seek(toTime time: TimeInterval) {
        guard parsed != nil, !blocks.isEmpty, estimatedDuration > 0 else { return }
        let fraction = max(0, min(1, time / estimatedDuration))
        let index = Int((fraction * Double(blocks.count - 1)).rounded())
        elapsed = time
        jump(toBlock: index)
    }

    /// Apply a new speed; if currently playing, re-speak the current block so
    /// the change takes effect immediately.
    func setSpeed(_ speed: Double) {
        settings.speed = AppSettings.clampSpeed(speed)
        estimatedDuration = Self.estimateDuration(parsed, speed: settings.speed)
        if isPlaying { speakBlock(at: currentBlockIndex) }
    }

    func stop() {
        playToken += 1
        engine.stop()
        isPlaying = false
        stopTimer()
    }

    // MARK: - Speaking internals

    private func speakBlock(at index: Int) {
        guard blocks.indices.contains(index) else {
            complete()
            return
        }
        // Skip-silently: read straight past images without announcing them.
        if blocks[index].isImage, settings.imageBehavior == .skipSilently {
            speakBlock(at: index + 1)
            return
        }
        ensureEngine()
        playToken += 1
        currentBlockIndex = index
        currentBlockSpoken = false
        spokenLog.append((index, elapsed))
        isPlaying = true
        startTimer()
        updateNowPlaying()
        recordProgress()

        let block = blocks[index]
        if case .image(let image) = block {
            // Try to describe the image (on-device Vision); fall back to the
            // default phrase when offline / nothing recognized.
            let fallback = block.spokenText
            let token = playToken
            Task { [weak self] in
                let text = await self?.imageDescriber.describe(image) ?? fallback
                // Bail if the listener moved on or switched email while we fetched.
                guard let self, self.playToken == token, self.isPlaying else { return }
                self.engine.speak(text, speed: self.settings.speed, pauseAfter: 0.2)
            }
        } else {
            engine.speak(block.spokenText, speed: settings.speed, pauseAfter: 0.2)
        }
    }

    private func handleUtteranceFinished(natural: Bool) {
        guard natural else { return }
        let finished = currentBlockIndex
        // If we just announced an image and the user wants to digest images, stop here.
        if blocks.indices.contains(finished),
           blocks[finished].isImage,
           settings.imageBehavior == .pauseAndDigest {
            currentBlockSpoken = true
            isPlaying = false
            stopTimer()
            updateNowPlaying()
            return
        }
        speakBlock(at: finished + 1)
    }

    private func handleEngineError(_ message: String) {
        errorMessage = message
        isPlaying = false
        stopTimer()
        updateNowPlaying()
    }

    private func complete() {
        isComplete = true
        isPlaying = false
        stopTimer()
        updateNowPlaying()
        recordProgress()
        recordCompletedAnalytics()
        SoundEffects.shared.play(.success)   // "finished this email" chime
        if let id = parsed?.email.id { markRead(id: id) }
        advanceToNextUnread()
    }

    /// Count a finished email/article toward the listening analytics.
    private func recordCompletedAnalytics() {
        guard let parsed else { return }
        let words = parsed.blocks.reduce(0) {
            $0 + $1.spokenText.split { c in c == " " || c == "\n" || c == "\t" || c == "\r" }.count
        }
        analytics.recordCompleted(from: parsed.email.from, words: words, seconds: elapsed)
    }

    /// Mark the email read on the server and locally — used both on completion
    /// and when the listener marks it read without finishing.
    private func markRead(id: String) {
        onMarkedRead?(id)
        if let markReadOverride {
            markReadOverride(id)
        } else {
            let service = mailService
            Task { [weak self] in
                do {
                    try await service.markRead(id: id)
                } catch {
                    // Don't swallow: a failure here usually means the Gmail token
                    // lacks the modify scope (sign out and back in to grant it).
                    self?.errorMessage = "Couldn't mark this read in Gmail: \(error.localizedDescription)"
                }
            }
        }
    }

    // MARK: - Progress & auto-advance

    /// Persist how far the listener has reached, so the inbox shows progress and
    /// reopening resumes here.
    private func recordProgress() {
        guard let id = parsed?.email.id, !blocks.isEmpty else { return }
        progressStore.record(
            id: id,
            blockIndex: currentBlockIndex,
            blockCount: blocks.count,
            isComplete: isComplete
        )
    }

    /// If auto-advance is on, load the next unread email, announce it, and play.
    private func advanceToNextUnread() {
        guard settings.autoAdvance,
              let provider = nextUnreadProvider,
              let currentID = parsed?.email.id,
              let next = provider(currentID) else { return }
        Task {
            await load(email: next, announce: true)
            guard errorMessage == nil else { return }
            // Transition chime, then the spoken "From … / subject" announcement.
            SoundEffects.shared.play(.transition)
            try? await Task.sleep(nanoseconds: 500_000_000)
            play()
        }
    }

    /// The remote URL of the last image at or before the current block — the
    /// image stays as lock-screen artwork until a later image replaces it.
    private func mostRecentImageURL() -> URL? {
        guard !blocks.isEmpty else { return nil }
        let upTo = min(currentBlockIndex, blocks.count - 1)
        guard upTo >= 0 else { return nil }
        for i in stride(from: upTo, through: 0, by: -1) {
            if case .image(let image) = blocks[i], let url = image.remoteURL {
                return url
            }
        }
        return nil
    }

    /// Spoken header read at the start of an auto-advanced email: who it's from
    /// and its subject.
    private static func announcement(for email: Email) -> String {
        "From \(email.from.displayName). \(email.subjectOrFallback)."
    }

    // MARK: - Engine selection

    private func currentEngineSignature() -> String {
        settings.elevenLabsActive
            ? "eleven:\(settings.elevenLabsVoiceID)"
            : "system:\(settings.voiceIdentifier)"
    }

    private static func makeEngine(settings: AppSettings) -> SpeechEngine {
        if settings.elevenLabsActive {
            return ElevenLabsSpeechEngine(
                client: ElevenLabsClient(apiKey: settings.elevenLabsAPIKey),
                voiceID: settings.elevenLabsVoiceID
            )
        }
        return SystemSpeechEngine(voiceIdentifier: settings.voiceIdentifier)
    }

    /// Rebuild the engine if the user changed voice provider/voice in settings.
    private func ensureEngine() {
        let signature = currentEngineSignature()
        guard signature != engineSignature else { return }
        engine.stop()
        engine = Self.makeEngine(settings: settings)
        engine.preferredLanguage = dominantLanguageCode
        wire(engine)
        engineSignature = signature
    }

    private func wire(_ engine: SpeechEngine) {
        engine.onFinish = { [weak self] natural in self?.handleUtteranceFinished(natural: natural) }
        engine.onWordRange = { [weak self] range in self?.spokenWordRange = range }
        engine.onError = { [weak self] message in self?.handleEngineError(message) }
        if let eleven = engine as? ElevenLabsSpeechEngine {
            eleven.onSynthesized = { [weak self] chars in
                self?.analytics.recordElevenLabsCharacters(chars)
            }
        }
    }

    // MARK: - Highlighting

    /// Capture the trailing ~10 seconds of speech as a highlight. When
    /// `presentComposer` is true the UI is asked to offer a typed note;
    /// the hands-free AirPods path passes false and dictates instead.
    @discardableResult
    func captureHighlight(presentComposer: Bool = true) -> Highlight? {
        guard let parsed else { return nil }
        let cutoff = elapsed - Highlight.lookbackWindow
        let startIdx = spokenLog.lastIndex(where: { $0.start <= cutoff }) ?? spokenLog.startIndex
        let recent = spokenLog.isEmpty ? [] : Array(spokenLog[startIdx...])
        let text = recent
            .compactMap { blocks.indices.contains($0.index) ? blocks[$0.index].spokenText : nil }
            .joined(separator: " ")

        let highlight = Highlight(
            emailID: parsed.email.id,
            emailSubject: parsed.email.subjectOrFallback,
            audioOffset: elapsed,
            blockIndex: currentBlockIndex,
            capturedText: text.isEmpty ? (currentBlock?.spokenText ?? "") : text
        )
        highlights.add(highlight)
        if presentComposer { onHighlightCaptured?(highlight) }
        return highlight
    }

    /// AirPods flow: capture a highlight, then ask (out loud) whether to add a
    /// note and dictate it — all hands-free — before resuming playback.
    func captureHighlightAndDictate() {
        guard let highlight = captureHighlight(presentComposer: false) else { return }
        // Confirm the capture immediately (the screen may be in a pocket), so the
        // listener knows the press registered before the spoken prompt.
        Haptics.success()
        let wasPlaying = isPlaying
        // Fully stop (not pause): the recorder switches the audio session to
        // record mode, which a merely-paused synthesizer would keep fighting for.
        stop()
        Task { [weak self] in
            guard let self else { return }
            let outcome = await self.voiceRecorder.captureNote()
            if case .note(let text) = outcome {
                self.highlights.updateNote(for: highlight.id, note: text)
            }
            // Restore the playback session the recorder reconfigured, then
            // re-speak the current sentence so we pick up cleanly.
            SpeechAudioSession.activate()
            if wasPlaying { self.speakBlock(at: self.currentBlockIndex) }
        }
    }

    // MARK: - Timer / now playing

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isPlaying else { return }
                self.elapsed += 0.2
            }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    /// Wire hardware/transport controls (AirPods, lock screen, CarPlay) to this
    /// player. Next/Previous always move by sentence; the lock-screen scrubber
    /// seeks by position; Bookmark captures a highlight.
    func bindRemoteCommands() {
        remote.onTogglePlayPause = { [weak self] in self?.togglePlayPause() }
        remote.onPlay = { [weak self] in self?.play() }
        remote.onPause = { [weak self] in self?.pause() }
        remote.onPrevious = { [weak self] in self?.previousSentence() }
        remote.onNext = { [weak self] in
            guard let self else { return }
            // While an image is showing, Next skips it; otherwise next sentence.
            if self.isOnImage { self.skipImage() } else { self.nextSentence() }
        }
        remote.onSeek = { [weak self] time in self?.seek(toTime: time) }
        remote.onBookmark = { [weak self] in
            guard let self else { return }
            // Capture a highlight; if voice notes are on, offer to dictate one.
            if self.settings.airPodsHighlightEnabled {
                self.captureHighlightAndDictate()
            } else {
                _ = self.captureHighlight(presentComposer: false)
                Haptics.success()
            }
        }
        remote.start()

        #if canImport(WatchConnectivity)
        // Relay watch transport commands to this (single, app-wide) player.
        WatchConnectivityBridge.shared.onCommand = { [weak self] command in
            guard let self else { return }
            switch command {
            case .play: self.play()
            case .pause: self.pause()
            case .nextSentence: self.nextSentence()
            case .previousSentence: self.previousSentence()
            case .highlight: _ = self.captureHighlight()
            }
        }
        #endif
    }

    func unbindRemoteCommands() {
        remote.stop()
        stop()
    }

    private func updateNowPlaying() {
        guard let parsed else { return }
        // Keep the most recently passed image on the lock screen until the next
        // image (so the listener can still glance at it), falling back to the
        // sender's photo/logo before any image has appeared.
        let imageCandidates: [URL]
        if let url = mostRecentImageURL() {
            imageCandidates = [url]
        } else {
            imageCandidates = SenderImage.candidateURLs(forAddress: parsed.email.from.address)
        }
        remote.updateNowPlaying(
            title: parsed.email.subjectOrFallback,
            sender: parsed.email.from.displayName,
            isPlaying: isPlaying,
            elapsed: elapsed,
            duration: estimatedDuration,
            imageCandidates: imageCandidates
        )
    }

    // MARK: - Duration estimate

    private static func estimateDuration(_ parsed: ParsedEmail?, speed: Double) -> TimeInterval {
        guard let parsed else { return 1 }
        let chars = parsed.blocks.reduce(0) { $0 + $1.spokenText.count }
        let charsPerSecond = 14.0 * AppSettings.clampSpeed(speed)
        return max(Double(chars) / charsPerSecond, 1)
    }
}
