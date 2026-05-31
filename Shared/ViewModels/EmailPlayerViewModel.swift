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

    // Elapsed playback seconds (advances only while speaking).
    @Published private(set) var elapsed: TimeInterval = 0

    /// Called after the email is marked read, so the inbox can update.
    var onMarkedRead: ((String) -> Void)?
    /// When set, used instead of the mail service to persist "read" — e.g. saved
    /// articles, which live in the local store rather than on a mail server.
    var markReadOverride: ((String) -> Void)?
    /// Called when a highlight is captured (e.g. via AirPods) so the UI can
    /// offer to add a note.
    var onHighlightCaptured: ((Highlight) -> Void)?

    private var mailService: MailService
    private let settings: AppSettings
    private let highlights: HighlightStore

    private var engine: SpeechEngine
    /// Identifies the engine config in use, so we rebuild only when it changes.
    private var engineSignature = ""

    private var hasStarted = false
    /// True when the current block has finished and we're idle on it (e.g.
    /// paused to digest an image), so the next Play advances past it.
    private var currentBlockSpoken = false
    private var timer: Timer?
    private var estimatedDuration: TimeInterval = 1
    /// Log of (blockIndex, elapsedAtStart) for the highlight lookback window.
    private var spokenLog: [(index: Int, start: TimeInterval)] = []
    private let remote = RemoteCommandController()

    init(mailService: MailService,
         settings: AppSettings = .shared,
         highlights: HighlightStore = .shared) {
        self.mailService = mailService
        self.settings = settings
        self.highlights = highlights
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

    // MARK: - Loading

    func load(email: Email) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let full = try await mailService.fetchFullEmail(id: email.id)
            await apply(full)
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

    private func apply(_ email: Email) async {
        // Parse off the main thread: real email/article HTML can be large, and
        // the tokenizer pass would otherwise freeze the UI.
        let parsed = await Task.detached(priority: .userInitiated) {
            EmailParser.parse(email)
        }.value
        self.parsed = parsed
        self.estimatedDuration = Self.estimateDuration(parsed, speed: settings.speed)
        self.currentBlockIndex = 0
        self.isComplete = false
        self.hasStarted = false
        self.currentBlockSpoken = false
        self.elapsed = 0
        self.spokenLog = []
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

    /// Apply a new speed; if currently playing, re-speak the current block so
    /// the change takes effect immediately.
    func setSpeed(_ speed: Double) {
        settings.speed = AppSettings.clampSpeed(speed)
        estimatedDuration = Self.estimateDuration(parsed, speed: settings.speed)
        if isPlaying { speakBlock(at: currentBlockIndex) }
    }

    func stop() {
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
        ensureEngine()
        currentBlockIndex = index
        currentBlockSpoken = false
        spokenLog.append((index, elapsed))
        let block = blocks[index]
        engine.speak(block.spokenText, speed: settings.speed, pauseAfter: 0.2)
        isPlaying = true
        startTimer()
        updateNowPlaying()
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
        guard let id = parsed?.email.id else { return }
        markRead(id: id)
    }

    /// Mark the email read on the server and locally — used both on completion
    /// and when the listener marks it read without finishing.
    private func markRead(id: String) {
        onMarkedRead?(id)
        if let markReadOverride {
            markReadOverride(id)
        } else {
            Task { try? await mailService.markRead(id: id) }
        }
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
        wire(engine)
        engineSignature = signature
    }

    private func wire(_ engine: SpeechEngine) {
        engine.onFinish = { [weak self] natural in self?.handleUtteranceFinished(natural: natural) }
        engine.onWordRange = { [weak self] range in self?.spokenWordRange = range }
        engine.onError = { [weak self] message in self?.handleEngineError(message) }
    }

    // MARK: - Highlighting

    /// Capture the trailing ~10 seconds of speech as a highlight.
    @discardableResult
    func captureHighlight() -> Highlight? {
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
        onHighlightCaptured?(highlight)
        return highlight
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

    /// Wire hardware/transport controls (AirPods, lock screen) to this player.
    /// The next-track button is context-aware: it skips the current image when
    /// one is showing, otherwise it captures a highlight (if AirPods-highlight
    /// is on) or skips to the next sentence.
    func bindRemoteCommands() {
        remote.onTogglePlayPause = { [weak self] in self?.togglePlayPause() }
        remote.onPlay = { [weak self] in self?.play() }
        remote.onPause = { [weak self] in self?.pause() }
        remote.onPrevious = { [weak self] in self?.previousSentence() }
        remote.onNext = { [weak self] in
            guard let self else { return }
            if self.isOnImage {
                self.skipImage()
            } else if self.settings.airPodsHighlightEnabled {
                self.captureHighlight()
            } else {
                self.nextSentence()
            }
        }
        remote.start()
    }

    func unbindRemoteCommands() {
        remote.stop()
        stop()
    }

    private func updateNowPlaying() {
        guard let parsed else { return }
        var imageURL: URL?
        if case .image(let image)? = currentBlock {
            imageURL = image.remoteURL
        }
        remote.updateNowPlaying(
            title: parsed.email.subjectOrFallback,
            sender: parsed.email.from.displayName,
            isPlaying: isPlaying,
            elapsed: elapsed,
            duration: estimatedDuration,
            imageURL: imageURL
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
