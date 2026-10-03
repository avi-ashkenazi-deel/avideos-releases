import Foundation
import os

/// YouTube Data API v3 calls for going live through the connected account:
/// create a broadcast + stream and bind them (so there's no key to paste and
/// the broadcast starts/stops with the stream), find the live chat of a
/// broadcast that's already running, and the channel name for Settings.
///
/// Every call needs the `youtube.force-ssl` scope (`GoogleOAuth`).
/// verify on Mac: the account must have live streaming enabled (YouTube
/// Studio → Go live, first time takes up to 24 h).
enum YouTubeLiveService {
    private static let base = URL(string: "https://www.googleapis.com/youtube/v3/")!
    private static let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "youtube-live")

    struct APIError: LocalizedError {
        var message: String
        var errorDescription: String? { "YouTube: \(message)" }
    }

    /// Creates a broadcast for this destination, a stream to feed it, binds
    /// them, and returns the ingest plus the chat id and watch link.
    @MainActor
    static func prepare(destination: StreamDestination) async throws -> PreparedBroadcast {
        let title = (destination.broadcastTitle?.isEmpty == false ? destination.broadcastTitle : nil)
            ?? "Live on \(Date().formatted(date: .abbreviated, time: .shortened))"
        let privacy = destination.broadcastPrivacy ?? "unlisted"
        let formatter = ISO8601DateFormatter()

        let broadcast = try await request(
            "liveBroadcasts?part=snippet,status,contentDetails",
            method: "POST",
            body: [
                "snippet": [
                    "title": title,
                    "scheduledStartTime": formatter.string(from: Date()),
                ],
                "status": [
                    "privacyStatus": privacy,
                    "selfDeclaredMadeForKids": false,
                ],
                "contentDetails": [
                    "enableAutoStart": true,
                    "enableAutoStop": true,
                    "enableDvr": true,
                    "latencyPreference": "low",
                    "monitorStream": ["enableMonitorStream": false],
                ],
            ])
        guard let broadcastID = broadcast["id"] as? String else {
            throw APIError(message: "the broadcast wasn't created")
        }
        let snippet = broadcast["snippet"] as? [String: Any]
        let liveChatID = snippet?["liveChatId"] as? String

        let stream = try await request(
            "liveStreams?part=snippet,cdn,contentDetails",
            method: "POST",
            body: [
                "snippet": ["title": "\(title) (\(destination.orientation.shortName))"],
                "cdn": [
                    "ingestionType": "rtmp",
                    "resolution": "variable",
                    "frameRate": "variable",
                ],
                "contentDetails": ["isReusable": false],
            ])
        guard let streamID = stream["id"] as? String,
              let cdn = stream["cdn"] as? [String: Any],
              let ingestion = cdn["ingestionInfo"] as? [String: Any],
              let streamName = ingestion["streamName"] as? String else {
            throw APIError(message: "the stream wasn't created")
        }
        // RTMPS when YouTube offers it: the key never crosses the wire in clear.
        let address = (ingestion["rtmpsIngestionAddress"] as? String)
            ?? (ingestion["ingestionAddress"] as? String)
            ?? "rtmp://a.rtmp.youtube.com/live2"

        _ = try await request(
            "liveBroadcasts/bind?id=\(broadcastID)&part=id,contentDetails&streamId=\(streamID)",
            method: "POST",
            body: nil)

        log.notice("YouTube broadcast \(broadcastID, privacy: .public) ready")
        return PreparedBroadcast(serverURL: address,
                                 streamKey: streamName,
                                 liveChatID: liveChatID,
                                 watchURL: URL(string: "https://www.youtube.com/watch?v=\(broadcastID)"))
    }

    /// The chat of the account's broadcast that's on air right now: how a
    /// pasted-key YouTube destination still gets comments once the account
    /// is connected. nil until YouTube flips the broadcast to live.
    @MainActor
    static func activeLiveChatID() async throws -> String? {
        let response = try await request("liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all",
                                         method: "GET", body: nil)
        let items = response["items"] as? [[String: Any]] ?? []
        for item in items {
            if let chat = (item["snippet"] as? [String: Any])?["liveChatId"] as? String {
                return chat
            }
        }
        return nil
    }

    @MainActor
    static func channelTitle() async throws -> String? {
        let response = try await request("channels?part=snippet&mine=true", method: "GET", body: nil)
        let items = response["items"] as? [[String: Any]]
        return (items?.first?["snippet"] as? [String: Any])?["title"] as? String
    }

    // MARK: - Transport

    @MainActor
    static func request(_ path: String, method: String, body: [String: Any]?) async throws -> [String: Any] {
        let token = try await GoogleOAuth.shared.accessToken()
        guard let url = URL(string: path, relativeTo: base) else {
            throw APIError(message: "bad request \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(message: errorMessage(from: json) ?? "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        return json
    }

    /// Google's `{"error": {"message": …, "errors": [{"reason": …}]}}`,
    /// with the reasons hosts actually hit turned into plain advice.
    static func errorMessage(from json: [String: Any]) -> String? {
        guard let error = json["error"] as? [String: Any] else { return nil }
        let reason = ((error["errors"] as? [[String: Any]])?.first?["reason"] as? String) ?? ""
        switch reason {
        case "liveStreamingNotEnabled":
            return "live streaming isn't enabled on this channel yet. Turn it on in YouTube Studio (it can take 24 hours)."
        case "quotaExceeded":
            return "the API quota for today is used up. Use a stream key for now."
        case "liveChatEnded", "liveChatNotFound":
            return "the live chat has ended."
        default:
            return error["message"] as? String
        }
    }
}
