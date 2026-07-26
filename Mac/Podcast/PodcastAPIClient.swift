import Foundation
import Security
import os

// MARK: - Keychain

/// Minimal generic-password Keychain wrapper for podcast-mode secrets.
/// The host key lives under service "com.aviashkenazi.avideos.hostkey".
struct KeychainStore: Sendable {
    static let hostKeyService = "com.aviashkenazi.avideos.hostkey"
    static let defaultAccount = "default"

    enum KeychainError: LocalizedError {
        case unexpectedStatus(OSStatus)
        case notFound

        var errorDescription: String? {
            switch self {
            case .unexpectedStatus(let status):
                let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
                return "Keychain error: \(message)"
            case .notFound:
                return "No host key found in the Keychain. Paste your worker host key in Settings."
            }
        }
    }

    var service: String
    var account: String

    init(service: String = KeychainStore.hostKeyService, account: String = KeychainStore.defaultAccount) {
        self.service = service
        self.account = account
    }

    func readString() throws -> String {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let string = String(data: data, encoding: .utf8) else {
                throw KeychainError.notFound
            }
            return string
        case errSecItemNotFound:
            throw KeychainError.notFound
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func writeString(_ value: String) throws {
        let data = Data(value.utf8)
        var update: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var add = baseQuery
            add[kSecValueData as String] = data
            update.removeAll()
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

// MARK: - Errors

enum PodcastAPIError: LocalizedError {
    case transport(underlying: Error)
    case httpStatus(code: Int, serverMessage: String?)
    case decoding(underlying: Error, bodyPreview: String)
    case notHTTPResponse

    var errorDescription: String? {
        switch self {
        case .transport(let underlying):
            return "Network error: \(underlying.localizedDescription)"
        case .httpStatus(let code, let serverMessage):
            if let serverMessage, !serverMessage.isEmpty {
                return "Server error \(code): \(serverMessage)"
            }
            return "Server error \(code)."
        case .decoding(let underlying, let bodyPreview):
            return "Unexpected server response (\(underlying.localizedDescription)): \(bodyPreview)"
        case .notHTTPResponse:
            return "Unexpected non-HTTP server response."
        }
    }
}

// MARK: - Wire types

struct CreateSessionResponse: Decodable, Sendable {
    var sessionId: String
    var hostToken: String
    var livekitUrl: String
    var inviteUrl: String
}

struct JoinSessionResponse: Decodable, Sendable {
    var participantId: String
    var token: String
    var livekitUrl: String
    var uploadGrant: String
    var serverTimeMs: Double
}

struct ServerTimeResponse: Decodable, Sendable {
    var serverTimeMs: Double
}

struct SignedURL: Decodable, Sendable {
    var key: String
    var url: String
}

struct SignedURLBatch: Decodable, Sendable {
    var urls: [SignedURL]
    var expiresInSeconds: Double?
}

/// Prefix-mode response of POST /v1/sessions/:id/downloads/sign.
struct DownloadKeyList: Decodable, Sendable {
    var keys: [String]
    var truncated: Bool
}

/// Merge patch for POST /v1/sessions/:id/manifest — exactly one of the
/// optional members should normally be set per call.
struct ManifestPatch: Encodable, Sendable {
    var participant: SessionParticipant?
    var take: TakePatch?
    var track: TrackPatch?

    struct TakePatch: Encodable, Sendable {
        var id: String
        var startedAtSession: Double
    }

    /// Mirrors `TrackRecord` minus the local-only `localURL`, plus the
    /// `takeId` the worker needs to nest the track.
    struct TrackPatch: Encodable, Sendable {
        var takeId: String
        var participantId: String
        var kind: TrackKind
        var anchor: ClockAnchor?
        var chunkCount: Int?
        var chunkTimeline: [ChunkStamp]?
        var finalized: Bool?
        var mimeType: String?
        var width: Int?
        var height: Int?
    }
}

struct ManifestPatchResponse: Decodable, Sendable {
    var ok: Bool
    var manifest: RemoteManifest
}

/// The worker's manifest document (infra/worker/src/manifest.ts). Tracks are
/// a flat ARRAY under each take; each track carries its own participantId +
/// kind (the worker upserts on that pair, it does not key a map by it).
struct RemoteManifest: Decodable, Sendable {
    var id: String?
    var sessionId: String?
    var createdAt: Date?
    var livekitRoom: String?
    var participants: [SessionParticipant]?
    var takes: [RemoteTake]?

    var resolvedId: String { id ?? sessionId ?? "" }

    struct RemoteTake: Decodable, Sendable {
        var id: String
        /// Absent when the take row was created implicitly by a track patch
        /// arriving before the host's take patch (manifest.ts findOrCreateTake).
        var startedAtSession: Double?
        var tracks: [RemoteTrack]?
    }

    struct RemoteTrack: Decodable, Sendable {
        var participantId: String?
        var kind: TrackKind?
        var anchor: ClockAnchor?
        var chunkCount: Int?
        var chunkTimeline: [ChunkStamp]?
        var finalized: Bool?
        var mimeType: String?
        var width: Int?
        var height: Int?
    }

    /// Converts the wire manifest into the app model. Tracks missing their
    /// identity pair (never produced by the worker) are dropped.
    func toRecordingSession() -> RecordingSession {
        let mappedTakes: [TakeRecord] = (takes ?? []).map { take in
            let tracks: [TrackRecord] = (take.tracks ?? []).compactMap { remote in
                guard let participantId = remote.participantId, let kind = remote.kind else { return nil }
                return TrackRecord(
                    participantId: participantId,
                    kind: kind,
                    anchor: remote.anchor,
                    chunkCount: remote.chunkCount ?? 0,
                    chunkTimeline: remote.chunkTimeline ?? [],
                    finalized: remote.finalized ?? false,
                    mimeType: remote.mimeType,
                    width: remote.width,
                    height: remote.height,
                    localURL: nil
                )
            }
            .sorted { ($0.participantId, $0.kind.rawValue) < ($1.participantId, $1.kind.rawValue) }
            return TakeRecord(id: take.id, startedAtSession: take.startedAtSession ?? 0, tracks: tracks)
        }
        return RecordingSession(
            id: resolvedId,
            createdAt: createdAt ?? Date(),
            livekitRoom: livekitRoom ?? resolvedId,
            participants: participants ?? [],
            takes: mappedTakes.sorted { $0.startedAtSession < $1.startedAtSession }
        )
    }
}

// MARK: - Client

/// Async URLSession client for the podcast Cloudflare Worker.
struct PodcastAPIClient: Sendable {
    /// Which credential authenticates a manifest call.
    enum ManifestAuth: Sendable {
        case hostKey
        case uploadGrant(String)
    }

    let baseURL: URL

    private let hostKey: String
    private let urlSession: URLSession
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "PodcastAPI")

    init(baseURL: URL, hostKey: String, urlSession: URLSession = PodcastAPIClient.makeURLSession()) {
        self.baseURL = baseURL
        self.hostKey = hostKey
        self.urlSession = urlSession
    }

    /// Convenience: builds a client with the host key stored in the Keychain.
    init(baseURL: URL) throws {
        self.init(baseURL: baseURL, hostKey: try KeychainStore().readString())
    }

    static func makeURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    // MARK: Endpoints

    /// POST /v1/sessions
    func createSession() async throws -> CreateSessionResponse {
        try await send(method: "POST", path: "v1/sessions", headers: hostKeyHeader)
    }

    /// POST /v1/sessions/:id/join — no credential; the invite URL is the secret.
    func joinSession(sessionId: String, name: String) async throws -> JoinSessionResponse {
        struct Body: Encodable { var name: String }
        return try await send(
            method: "POST",
            path: "v1/sessions/\(sessionId)/join",
            headers: [:],
            body: Body(name: name)
        )
    }

    /// GET /v1/time
    func serverTimeMs() async throws -> Double {
        let response: ServerTimeResponse = try await send(method: "GET", path: "v1/time", headers: [:])
        return response.serverTimeMs
    }

    /// POST /v1/sessions/:id/uploads/sign
    func signUploads(sessionId: String, keys: [String], uploadGrant: String) async throws -> SignedURLBatch {
        struct Body: Encodable { var keys: [String] }
        return try await send(
            method: "POST",
            path: "v1/sessions/\(sessionId)/uploads/sign",
            headers: ["x-upload-grant": uploadGrant],
            body: Body(keys: keys)
        )
    }

    /// POST /v1/sessions/:id/manifest (merge patch)
    @discardableResult
    func patchManifest(sessionId: String, patch: ManifestPatch, auth: ManifestAuth = .hostKey) async throws -> ManifestPatchResponse {
        let headers: [String: String]
        switch auth {
        case .hostKey:
            headers = hostKeyHeader
        case .uploadGrant(let grant):
            headers = ["x-upload-grant": grant]
        }
        return try await send(
            method: "POST",
            path: "v1/sessions/\(sessionId)/manifest",
            headers: headers,
            body: patch
        )
    }

    /// GET /v1/sessions/:id/manifest
    func manifest(sessionId: String) async throws -> RemoteManifest {
        try await send(method: "GET", path: "v1/sessions/\(sessionId)/manifest", headers: hostKeyHeader)
    }

    /// POST /v1/sessions/:id/downloads/sign — keys mode (presigned GETs).
    func signDownloads(sessionId: String, keys: [String]) async throws -> SignedURLBatch {
        struct Body: Encodable { var keys: [String] }
        return try await send(
            method: "POST",
            path: "v1/sessions/\(sessionId)/downloads/sign",
            headers: hostKeyHeader,
            body: Body(keys: keys)
        )
    }

    /// POST /v1/sessions/:id/downloads/sign — prefix mode (key listing).
    func listDownloadKeys(sessionId: String, prefix: String) async throws -> DownloadKeyList {
        struct Body: Encodable { var prefix: String }
        return try await send(
            method: "POST",
            path: "v1/sessions/\(sessionId)/downloads/sign",
            headers: hostKeyHeader,
            body: Body(prefix: prefix)
        )
    }

    // MARK: Plumbing

    private var hostKeyHeader: [String: String] { ["x-host-key": hostKey] }

    private struct NoBody: Encodable {}
    private struct ErrorBody: Decodable { var error: String }

    private func send<Response: Decodable>(
        method: String,
        path: String,
        headers: [String: String]
    ) async throws -> Response {
        try await send(method: method, path: path, headers: headers, body: Optional<NoBody>.none)
    }

    private func send<Body: Encodable, Response: Decodable>(
        method: String,
        path: String,
        headers: [String: String],
        body: Body?
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (field, value) in headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            log.error("\(method, privacy: .public) \(path, privacy: .public) transport failure: \(error.localizedDescription, privacy: .public)")
            throw PodcastAPIError.transport(underlying: error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw PodcastAPIError.notHTTPResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let serverMessage = (try? Self.decoder.decode(ErrorBody.self, from: data))?.error
                ?? String(data: data.prefix(300), encoding: .utf8)
            log.error("\(method, privacy: .public) \(path, privacy: .public) -> \(http.statusCode): \(serverMessage ?? "<no body>", privacy: .public)")
            throw PodcastAPIError.httpStatus(code: http.statusCode, serverMessage: serverMessage)
        }

        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch {
            let preview = String(data: data.prefix(300), encoding: .utf8) ?? "<binary>"
            log.error("\(method, privacy: .public) \(path, privacy: .public) decode failure: \(error.localizedDescription, privacy: .public)")
            throw PodcastAPIError.decoding(underlying: error, bodyPreview: preview)
        }
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        // The worker writes ISO-8601 strings with fractional seconds
        // (manifest.ts: new Date().toISOString() for createdAt/joinedAt).
        // Keep the lenient decode (epoch ms/s as well) for forward compat.
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                // Heuristic: values past year ~33658 as seconds are ms.
                return Date(timeIntervalSince1970: number > 1_000_000_000_000 ? number / 1_000.0 : number)
            }
            let string = try container.decode(String.self)
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = iso.date(from: string) { return date }
            iso.formatOptions = [.withInternetDateTime]
            if let date = iso.date(from: string) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognized date: \(string)")
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }()
}
