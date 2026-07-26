import Foundation
import AppKit
import os

/// YouTube Data API v3 resumable upload. Requires a Google Cloud project
/// with the YouTube Data API enabled and an OAuth client (see
/// docs/DEV_SETUP.md); the token comes from PlatformAuth.
struct YouTubePublisher {
    let auth: PlatformAuth
    private static let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "youtube")

    func upload(item: PublishItem, onProgress: @escaping (Double) -> Void) async throws -> String? {
        let token = try auth.accessToken(for: .youtube)

        // 1. Start a resumable session with the metadata (chapters ride in
        //    the description — YouTube parses "00:00 Title" lines natively).
        var start = URLRequest(url: URL(string:
            "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status")!)
        start.httpMethod = "POST"
        start.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        start.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let metadata: [String: Any] = [
            "snippet": [
                "title": item.title,
                "description": item.descriptionText,
                "tags": item.tags,
                "categoryId": "22",
            ],
            "status": ["privacyStatus": "private"],   // publish privately; promote by hand
        ]
        start.httpBody = try JSONSerialization.data(withJSONObject: metadata)

        let (_, startResponse) = try await URLSession.shared.data(for: start)
        guard let http = startResponse as? HTTPURLResponse,
              http.statusCode == 200,
              let location = http.value(forHTTPHeaderField: "Location"),
              let uploadURL = URL(string: location) else {
            throw NSError(domain: "YouTubePublisher", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Couldn't start the YouTube upload session"])
        }

        // 2. Upload the file (single shot; URLSession streams from disk).
        var upload = URLRequest(url: uploadURL)
        upload.httpMethod = "PUT"
        upload.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        upload.setValue("video/*", forHTTPHeaderField: "Content-Type")
        onProgress(0.05)
        let (data, uploadResponse) = try await URLSession.shared.upload(for: upload, fromFile: item.fileURL)
        guard let uploadHTTP = uploadResponse as? HTTPURLResponse, uploadHTTP.statusCode == 200 else {
            throw NSError(domain: "YouTubePublisher", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "YouTube upload failed"])
        }
        onProgress(1)

        struct Response: Decodable { let id: String }
        let videoID = (try? JSONDecoder().decode(Response.self, from: data))?.id
        return videoID.map { "https://youtube.com/watch?v=\($0)" }
    }
}

/// TikTok Content Posting API (direct post). Requires a TikTok developer
/// app with the content.posting scope approved.
struct TikTokPublisher {
    let auth: PlatformAuth

    func upload(item: PublishItem, onProgress: @escaping (Double) -> Void) async throws -> String? {
        let token = try auth.accessToken(for: .tiktok)
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: item.fileURL.path)[.size] as? Int) ?? 0

        // 1. Initialize the upload.
        var initRequest = URLRequest(url: URL(string:
            "https://open.tiktokapis.com/v2/post/publish/video/init/")!)
        initRequest.httpMethod = "POST"
        initRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "post_info": [
                "title": item.title,
                "privacy_level": "SELF_ONLY",   // draft-style; promote in-app
            ],
            "source_info": [
                "source": "FILE_UPLOAD",
                "video_size": fileSize,
                "chunk_size": fileSize,
                "total_chunk_count": 1,
            ],
        ] as [String: Any])

        let (initData, initResponse) = try await URLSession.shared.data(for: initRequest)
        guard (initResponse as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "TikTokPublisher", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "TikTok init failed — is the app approved for content posting?"])
        }
        struct InitResponse: Decodable {
            struct DataBox: Decodable {
                let upload_url: String
                let publish_id: String
            }
            let data: DataBox
        }
        let initBox = try JSONDecoder().decode(InitResponse.self, from: initData)
        guard let uploadURL = URL(string: initBox.data.upload_url) else {
            throw NSError(domain: "TikTokPublisher", code: 2)
        }

        // 2. PUT the bytes.
        var put = URLRequest(url: uploadURL)
        put.httpMethod = "PUT"
        put.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        put.setValue("bytes 0-\(max(fileSize - 1, 0))/\(fileSize)", forHTTPHeaderField: "Content-Range")
        onProgress(0.1)
        let (_, putResponse) = try await URLSession.shared.upload(for: put, fromFile: item.fileURL)
        guard let putHTTP = putResponse as? HTTPURLResponse, (200...299).contains(putHTTP.statusCode) else {
            throw NSError(domain: "TikTokPublisher", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "TikTok upload failed"])
        }
        onProgress(1)
        return nil   // TikTok processes async; the post appears in the app's drafts/inbox
    }
}

/// Instagram Graph API (Reels). Requires a Business/Creator account linked
/// to a Facebook app — when unavailable, export-to-disk + manual posting is
/// the documented fallback.
struct InstagramPublisher {
    let auth: PlatformAuth

    func upload(item: PublishItem, onProgress: @escaping (Double) -> Void) async throws -> String? {
        _ = try auth.accessToken(for: .instagram)
        // The Graph API requires the video at a PUBLIC URL (it pulls, we
        // can't push bytes). v1 ships without a public file host, so guide
        // the user to the manual flow rather than half-working:
        NSWorkspace.shared.selectFile(item.fileURL.path,
                                      inFileViewerRootedAtPath: item.fileURL.deletingLastPathComponent().path)
        throw NSError(domain: "InstagramPublisher", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Instagram's API needs the video on a public URL. The file is selected in Finder — post it with the Instagram app, or connect a public host in a future update.",
        ])
    }
}
