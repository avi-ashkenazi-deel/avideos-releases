import Foundation
import os

/// One page of `liveChatMessages.list`, decoded (pure, unit-tested).
struct YouTubeChatPage: Decodable {
    struct Item: Decodable {
        struct Snippet: Decodable {
            struct SuperChat: Decodable { var amountDisplayString: String? }
            var type: String?
            var displayMessage: String?
            var publishedAt: String?
            var superChatDetails: SuperChat?
        }
        struct Author: Decodable {
            var displayName: String?
            var isChatModerator: Bool?
            var isChatOwner: Bool?
        }
        var id: String
        var snippet: Snippet?
        var authorDetails: Author?
    }

    var items: [Item]?
    var nextPageToken: String?
    var pollingIntervalMillis: Int?
    /// Set once the chat has closed (the broadcast ended).
    var offlineAt: String?

    static func decode(_ data: Data) throws -> YouTubeChatPage {
        try JSONDecoder().decode(YouTubeChatPage.self, from: data)
    }

    /// Text messages and Super Chats as comments; joins, deletions, polls
    /// and the like are skipped.
    func comments(destinationID: UUID?) -> [LiveComment] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return (items ?? []).compactMap { item in
            guard let snippet = item.snippet,
                  ["textMessageEvent", "superChatEvent"].contains(snippet.type ?? ""),
                  let text = snippet.displayMessage, !text.isEmpty else { return nil }
            let published = snippet.publishedAt.flatMap { formatter.date(from: $0) ?? plain.date(from: $0) }
            return LiveComment(id: "yt:\(item.id)",
                               platform: .youtube,
                               destinationID: destinationID,
                               author: item.authorDetails?.displayName ?? "Viewer",
                               authorColorHex: nil,
                               text: text,
                               timestamp: published ?? Date(),
                               isModerator: item.authorDetails?.isChatModerator ?? false,
                               isOwner: item.authorDetails?.isChatOwner ?? false,
                               amount: snippet.superChatDetails?.amountDisplayString)
        }
    }
}

/// Polls a YouTube live chat at the interval YouTube asks for. Chat reads
/// cost API quota, so it never polls faster than `minimumInterval`.
///
/// Without a chat id up front (a pasted-key destination), it asks the
/// connected account for its active broadcast until one shows up.
@MainActor
final class YouTubeChatSource: CommentSource {
    let platform: StreamPlatform = .youtube
    static let minimumInterval: Double = 5

    private var liveChatID: String?
    private let destinationID: UUID?
    private var runner: Task<Void, Never>?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "youtube-chat")

    init(liveChatID: String?, destinationID: UUID?) {
        self.liveChatID = liveChatID
        self.destinationID = destinationID
    }

    func start(onComments: @escaping @MainActor ([LiveComment]) -> Void,
               onStatus: @escaping @MainActor (CommentSourceStatus) -> Void) {
        runner?.cancel()
        runner = Task { [weak self] in
            await self?.run(onComments: onComments, onStatus: onStatus)
        }
    }

    func stop() {
        runner?.cancel()
        runner = nil
    }

    private func run(onComments: @escaping @MainActor ([LiveComment]) -> Void,
                     onStatus: @escaping @MainActor (CommentSourceStatus) -> Void) async {
        guard GoogleOAuth.shared.isConnected else {
            onStatus(.failed("Connect your YouTube account in Settings → Streaming to read chat."))
            return
        }

        // Find the chat: YouTube marks a broadcast active a few seconds
        // after the stream starts arriving.
        var lookups = 0
        while liveChatID == nil, !Task.isCancelled {
            onStatus(.waiting("Waiting for YouTube to start the broadcast…"))
            liveChatID = try? await YouTubeLiveService.activeLiveChatID()
            if liveChatID != nil { break }
            lookups += 1
            if lookups > 24 {
                onStatus(.failed("YouTube didn't report a live broadcast. Is the stream key from this account?"))
                return
            }
            try? await Task.sleep(for: .seconds(10))
        }
        guard let liveChatID else { return }

        var pageToken: String?
        var failures = 0
        while !Task.isCancelled {
            var interval = Self.minimumInterval
            do {
                var path = "liveChat/messages?liveChatId=\(liveChatID)&part=snippet,authorDetails&maxResults=200"
                if let pageToken { path += "&pageToken=\(pageToken)" }
                let json = try await YouTubeLiveService.request(path, method: "GET", body: nil)
                let data = try JSONSerialization.data(withJSONObject: json)
                let page = try YouTubeChatPage.decode(data)
                onStatus(.connected)
                failures = 0
                let batch = page.comments(destinationID: destinationID)
                if !batch.isEmpty { onComments(batch) }
                pageToken = page.nextPageToken ?? pageToken
                if page.offlineAt != nil {
                    onStatus(.waiting("The YouTube chat has closed."))
                    return
                }
                interval = max(Self.minimumInterval, Double(page.pollingIntervalMillis ?? 5000) / 1000)
            } catch {
                failures += 1
                log.error("YouTube chat poll failed: \(error.localizedDescription, privacy: .public)")
                onStatus(failures > 2 ? .failed(error.localizedDescription) : .waiting("Retrying YouTube chat…"))
                if let api = error as? YouTubeLiveService.APIError, api.message.contains("chat has ended") {
                    return
                }
                interval = min(60, Self.minimumInterval * Double(failures + 1))
            }
            try? await Task.sleep(for: .seconds(interval))
        }
    }
}
