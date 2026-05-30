import Foundation
import Combine

/// Drives playback of a single email: speaks it block by block, handles images
/// per the user's preference, tracks position for highlighting, and marks the
/// message read when it finishes.
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
    /// Called when a highlight is captured (e.g. via AirPods) so the UI can
    /// offer to add a note.
    var onHighlightCaptured: ((Highlight) -> Void)?

    private var mailService: MailService
    private let settings: AppSettings
    private let highlights: HighlightStore
    private let speech = SpeechReader()

    private var hasStarted = false
    private var timer: Timer?
    private var estimatedDuration: TimeInterval = 1
    /// Log of (blockIndex, elapsedAtStart) for the highlight lookback window.
    private var spokenLog: [(index: Int, start: TimeInterval)] = []
    private var cancellables = Set<AnyCancellable>()

    init(mailService: MailService,
         settings: AppSettings = .shared,
         highlights: HighlightStore = .shared) {
        self.mailService = mailService
        self.settings = settings
        self.highlights = highlights

        speech.onFinish = { [weak self] natural in
            self?.handleUtteranceFinished(natural: natural)
        }
        speech.$spokenWordRange
            .sink { [weak self] range in self?.spokenWordRange = range }
            .store(in: &cancellables)
    }

    /// Rebind to the active backend (demo vs Google) once `AppState` knows it.
    func configure(_ service: MailService) {
        mailService = service
    }

    var blocks: [ContentBlock] { parsed?.blocks ?? [] }

    var currentBlock: ContentBlock? {
        blocks.indices.contains(currentBlockIndex) ? blocks[currentBlockIndex] : nil
    }

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
            let parsed = EmailParser.parse(full)
            self.parsed = parsed
            self.estimatedDuration = Self.estimateDuration(parsed, speed: settings.speed)
            self.currentBlockIndex = 0
            self.isComplete = false
            self.hasStarted = false
            self.elapsed = 0
            self.spokenLog = []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Transport

    func togglePlayPause() { isPlaying ? pause() : play() }

    func play() {
        guard parsed != nil, !isComplete else { return }
        if !hasStarted {
            hasStarted = true
            speakBlock(at: 0)
            return
        }
        if speech.isPaused {
            speech.resume()
            isPlaying = true
            startTimer()
            updateNowPlaying()
            return
        }
        // Idle because we stopped on an image to digest it — continue past it.
        speakBlock(at: currentBlockIndex + 1)
    }

    func pause() {
        speech.pause()
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

    func jump(toBlock index: Int) {
        guard blocks.indices.contains(index) else { return }
        hasStarted = true
        isComplete = false
        speakBlock(at: index)
    }

    /// Apply a new speed; if currently playing, re-speak the current block so
    /// the change takes effect immediately.
    func setSpeed(_ speed: Double) {
        settings.speed = AppSettings.clampSpeed(speed)
        estimatedDuration = Self.estimateDuration(parsed, speed: settings.speed)
        if isPlaying { speakBlock(at: currentBlockIndex) }
    }

    func stop() {
        speech.stop()
        isPlaying = false
        stopTimer()
    }

    // MARK: - Speaking internals

    private func speakBlock(at index: Int) {
        guard blocks.indices.contains(index) else {
            complete()
            return
        }
        currentBlockIndex = index
        spokenLog.append((index, elapsed))
        let block = blocks[index]
        let pauseAfter = settings.removeSilence ? 0 : 0.2
        speech.speak(block.spokenText,
                     speed: settings.speed,
                     voiceIdentifier: settings.voiceIdentifier,
                     pauseAfter: pauseAfter)
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
            isPlaying = false
            stopTimer()
            updateNowPlaying()
            return
        }
        speakBlock(at: finished + 1)
    }

    private func complete() {
        isComplete = true
        isPlaying = false
        stopTimer()
        updateNowPlaying()
        guard let id = parsed?.email.id else { return }
        onMarkedRead?(id)
        Task { try? await mailService.markRead(id: id) }
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

    private let remote = RemoteCommandController()

    /// Wire hardware/transport controls (AirPods, lock screen) to this player.
    func bindRemoteCommands(airPodsHighlight: Bool) {
        remote.airPodsHighlightEnabled = airPodsHighlight
        remote.onTogglePlayPause = { [weak self] in self?.togglePlayPause() }
        remote.onPlay = { [weak self] in self?.play() }
        remote.onPause = { [weak self] in self?.pause() }
        remote.onNextSentence = { [weak self] in self?.nextSentence() }
        remote.onPreviousSentence = { [weak self] in self?.previousSentence() }
        remote.onHighlight = { [weak self] in self?.captureHighlight() }
        remote.start()
    }

    func unbindRemoteCommands() {
        remote.stop()
        stop()
    }

    private func updateNowPlaying() {
        guard let parsed else { return }
        remote.updateNowPlaying(
            title: parsed.email.subjectOrFallback,
            sender: parsed.email.from.displayName,
            isPlaying: isPlaying,
            elapsed: elapsed,
            duration: estimatedDuration
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
