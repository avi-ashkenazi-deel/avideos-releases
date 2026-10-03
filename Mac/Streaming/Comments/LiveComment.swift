import Foundation
import Observation

/// One chat message from any platform, normalized.
struct LiveComment: Identifiable, Hashable, Sendable {
    /// Platform-prefixed message id ("yt:…", "tw:…"), unique across sources.
    var id: String
    var platform: StreamPlatform
    /// The destination whose chat it came from.
    var destinationID: UUID?
    var author: String
    /// The author's chosen name color (Twitch), "#RRGGBB".
    var authorColorHex: String?
    var text: String
    var timestamp: Date
    var isModerator: Bool = false
    /// The channel owner (the host's own messages).
    var isOwner: Bool = false
    /// Super Chat / Bits, already formatted ("$5.00", "100 bits").
    var amount: String?
}

/// How the featured comment card looks on air. Persisted in UserDefaults.
struct CommentCardStyle: Codable, Hashable, Sendable {
    enum Position: String, Codable, CaseIterable, Sendable {
        case lowerLeft, lowerCenter, top

        var displayName: String {
            switch self {
            case .lowerLeft: "Lower left"
            case .lowerCenter: "Lower center"
            case .top: "Top"
            }
        }
    }

    var position: Position = .lowerLeft
    /// Message point size at the 1080p reference (the name is ~70% of it).
    var fontSize: Double = 40
    var boxColor: RGBAColor = RGBAColor(red: 0.08, green: 0.08, blue: 0.1, alpha: 0.88)
    var textColor: RGBAColor = .white
    /// Tint the author name with the platform color (YouTube red, Twitch
    /// purple…); off = the text color.
    var usesPlatformTint: Bool = true
}

/// Connection status of one chat source, for the Comments window header.
enum CommentSourceStatus: Equatable, Sendable {
    case connecting
    case connected
    /// Waiting on the platform (YouTube's chat appears once the broadcast is live).
    case waiting(String)
    case failed(String)

    var label: String {
        switch self {
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .waiting(let why): why
        case .failed(let why): why
        }
    }
}

/// Reads one platform's live chat. Implementations deliver on the main actor.
@MainActor
protocol CommentSource: AnyObject {
    var platform: StreamPlatform { get }
    func start(onComments: @escaping @MainActor ([LiveComment]) -> Void,
               onStatus: @escaping @MainActor (CommentSourceStatus) -> Void)
    func stop()
}

/// Every comment from every live destination, the host's shortlist, and the
/// one on air. **Nothing reaches air unless `feature(_:)` is called** — the
/// Comments window's button (or ↩) is the only caller.
@MainActor
@Observable
final class CommentsStore {
    static let maxComments = 500

    private(set) var comments: [LiveComment] = []
    /// Starred comments, in the host's order. Copies, so they outlive the
    /// 500-message window.
    private(set) var shortlist: [LiveComment] = []
    /// Already featured once (the "shown" tick).
    private(set) var shownIDs: Set<String> = []
    /// On screen now.
    private(set) var featured: LiveComment?
    private(set) var featuredAt: Date?
    /// Per destination: which platform, and how its chat connection is doing.
    private(set) var sourceStatus: [UUID: (platform: StreamPlatform, status: CommentSourceStatus)] = [:]

    /// Auto-hide after this many seconds; 0 = stays until hidden.
    var autoHideSeconds: Double = UserDefaults.standard.double(forKey: "comments.autoHideSeconds") {
        didSet { UserDefaults.standard.set(autoHideSeconds, forKey: "comments.autoHideSeconds") }
    }
    /// Clear the card when the scene changes (default on).
    var hidesOnSceneChange: Bool = UserDefaults.standard.object(forKey: "comments.hidesOnSceneChange") as? Bool ?? true {
        didSet { UserDefaults.standard.set(hidesOnSceneChange, forKey: "comments.hidesOnSceneChange") }
    }
    var style: CommentCardStyle = CommentsStore.loadStyle() {
        didSet {
            if let data = try? JSONEncoder().encode(style) {
                UserDefaults.standard.set(data, forKey: "comments.cardStyle")
            }
            onFeaturedChanged?()
        }
    }

    /// The studio recompiles the canvases (and animates) when this fires.
    @ObservationIgnored var onFeaturedChanged: (() -> Void)?

    @ObservationIgnored private var sources: [UUID: CommentSource] = [:]
    @ObservationIgnored private var seen: Set<String> = []
    @ObservationIgnored private var autoHideTask: Task<Void, Never>?

    // MARK: Sources

    func attach(_ source: CommentSource, destinationID: UUID) {
        sources[destinationID]?.stop()
        sources[destinationID] = source
        sourceStatus[destinationID] = (source.platform, .connecting)
        source.start(onComments: { [weak self] batch in
            self?.ingest(batch, destinationID: destinationID)
        }, onStatus: { [weak self] status in
            guard let self, self.sources[destinationID] === source else { return }
            self.sourceStatus[destinationID] = (source.platform, status)
        })
    }

    func setStatus(_ status: CommentSourceStatus, platform: StreamPlatform, destinationID: UUID) {
        sourceStatus[destinationID] = (platform, status)
    }

    /// Shows a destination with no readable chat (the reason greys it out).
    func noteUnsupported(platform: StreamPlatform, destinationID: UUID) {
        guard let reason = platform.commentsUnavailableReason else { return }
        sourceStatus[destinationID] = (platform, .failed(reason))
    }

    func detach(destinationID: UUID) {
        sources.removeValue(forKey: destinationID)?.stop()
        sourceStatus.removeValue(forKey: destinationID)
    }

    func detachAll() {
        for source in sources.values { source.stop() }
        sources.removeAll()
        sourceStatus.removeAll()
    }

    /// Platforms live right now, and whether each can deliver comments.
    var livePlatforms: [StreamPlatform] {
        Array(Set(sourceStatus.values.map(\.platform))).sorted { $0.rawValue < $1.rawValue }
    }

    func ingest(_ batch: [LiveComment], destinationID: UUID? = nil) {
        var fresh: [LiveComment] = []
        for var comment in batch where !seen.contains(comment.id) {
            seen.insert(comment.id)
            if comment.destinationID == nil { comment.destinationID = destinationID }
            fresh.append(comment)
        }
        guard !fresh.isEmpty else { return }
        comments.append(contentsOf: fresh)
        comments.sort { $0.timestamp < $1.timestamp }
        if comments.count > Self.maxComments {
            comments.removeFirst(comments.count - Self.maxComments)
        }
        // `seen` only needs to cover what could still arrive twice.
        if seen.count > Self.maxComments * 4 {
            seen = Set(comments.map(\.id))
        }
    }

    // MARK: Rehearsal

    /// A fake YouTube + Twitch chat, for trying the Comments window and the
    /// on-air card without going live. Its comments are clearly fake names.
    static let demoDestinationID = UUID(uuidString: "C0FFEE00-0000-4000-8000-00000000DE70")!
    var isDemoRunning: Bool { sources[Self.demoDestinationID] != nil }

    func toggleDemo() {
        if isDemoRunning {
            detach(destinationID: Self.demoDestinationID)
        } else {
            attach(DemoCommentSource(), destinationID: Self.demoDestinationID)
        }
    }

    // MARK: Shortlist

    func isShortlisted(_ comment: LiveComment) -> Bool {
        shortlist.contains { $0.id == comment.id }
    }

    func toggleShortlist(_ comment: LiveComment) {
        if let index = shortlist.firstIndex(where: { $0.id == comment.id }) {
            shortlist.remove(at: index)
        } else {
            shortlist.append(comment)
        }
    }

    func moveShortlist(fromOffsets source: IndexSet, toOffset destination: Int) {
        shortlist.move(fromOffsets: source, toOffset: destination)
    }

    func removeFromShortlist(id: String) {
        shortlist.removeAll { $0.id == id }
    }

    // MARK: On air

    func feature(_ comment: LiveComment) {
        featured = comment
        featuredAt = Date()
        shownIDs.insert(comment.id)
        onFeaturedChanged?()
        scheduleAutoHide(for: comment.id)
    }

    func hideFeatured() {
        guard featured != nil else { return }
        autoHideTask?.cancel()
        featured = nil
        featuredAt = nil
        onFeaturedChanged?()
    }

    /// Seconds left before auto-hide, for the countdown on the on-air strip.
    func autoHideRemaining(at now: Date) -> Double? {
        guard autoHideSeconds > 0, let featuredAt else { return nil }
        return max(0, autoHideSeconds - now.timeIntervalSince(featuredAt))
    }

    func clearAll() {
        hideFeatured()
        comments.removeAll()
        seen.removeAll()
        shownIDs.removeAll()
    }

    private func scheduleAutoHide(for id: String) {
        autoHideTask?.cancel()
        guard autoHideSeconds > 0 else { return }
        let delay = autoHideSeconds
        autoHideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.featured?.id == id else { return }
            self.hideFeatured()
        }
    }

    nonisolated private static func loadStyle() -> CommentCardStyle {
        guard let data = UserDefaults.standard.data(forKey: "comments.cardStyle"),
              let style = try? JSONDecoder().decode(CommentCardStyle.self, from: data) else {
            return CommentCardStyle()
        }
        return style
    }
}

/// Rehearsal chat: a believable comment every few seconds from both
/// platforms that have readable chat.
@MainActor
final class DemoCommentSource: CommentSource {
    let platform: StreamPlatform = .youtube
    private var runner: Task<Void, Never>?

    private static let lines: [(String, StreamPlatform, String)] = [
        ("Maya (demo)", .youtube, "This is so useful, thank you! Where can I find the slides?"),
        ("devon_k (demo)", .twitch, "first time catching this live, the audio sounds great"),
        ("Priya (demo)", .youtube, "Question: how would you handle this with a small team of three people?"),
        ("StreamFan42 (demo)", .twitch, "LUL the cat walked in"),
        ("Tom R (demo)", .youtube, "Greetings from Lisbon 👋"),
        ("nightowl (demo)", .twitch, "can you go back to the previous slide for a sec?"),
        ("Sam (demo)", .youtube, "What tool are you using for the overlays? They look really clean."),
        ("lena.codes (demo)", .twitch, "did you try the other approach first? curious what broke"),
        ("Jordan (demo)", .youtube, "Been following since the first episode. This one is the best so far."),
        ("ricky_b (demo)", .twitch, "hype hype hype"),
    ]

    func start(onComments: @escaping @MainActor ([LiveComment]) -> Void,
               onStatus: @escaping @MainActor (CommentSourceStatus) -> Void) {
        onStatus(.connected)
        runner = Task {
            var index = 0
            while !Task.isCancelled {
                let line = Self.lines[index % Self.lines.count]
                index += 1
                onComments([LiveComment(id: "demo:\(UUID().uuidString)",
                                        platform: line.1,
                                        destinationID: CommentsStore.demoDestinationID,
                                        author: line.0,
                                        authorColorHex: line.1 == .twitch ? "#1E90FF" : nil,
                                        text: line.2,
                                        timestamp: Date(),
                                        isModerator: index % 7 == 0,
                                        amount: index % 9 == 0 ? "$5.00" : nil)])
                try? await Task.sleep(for: .seconds(Double.random(in: 2...5)))
            }
        }
    }

    func stop() {
        runner?.cancel()
        runner = nil
    }
}
