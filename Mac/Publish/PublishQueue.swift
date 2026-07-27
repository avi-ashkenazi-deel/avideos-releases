import Foundation
import AuthenticationServices
import Observation
import os

/// Direct publishing to social platforms. Each platform needs an app
/// registration (client IDs live in Settings, tokens in the Keychain);
/// export-to-disk always works without any of this.
///
/// Scheduling is local: the app must be running at the scheduled time
/// (documented in the UI).
enum PublishPlatform: String, Codable, CaseIterable, Identifiable {
    case youtube
    case tiktok
    case instagram

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .youtube: "YouTube"
        case .tiktok: "TikTok"
        case .instagram: "Instagram"
        }
    }
}

struct PublishItem: Identifiable, Codable {
    enum Status: Codable, Equatable {
        case queued
        case scheduled(Date)
        case uploading(Double)
        case published(remoteURL: String?)
        case failed(String)
    }

    let id: UUID
    var platform: PublishPlatform
    var fileURL: URL
    var title: String
    var descriptionText: String
    var tags: [String]
    var scheduledAt: Date?
    var status: Status = .queued

    init(platform: PublishPlatform, fileURL: URL, title: String,
         descriptionText: String = "", tags: [String] = [], scheduledAt: Date? = nil) {
        self.id = UUID()
        self.platform = platform
        self.fileURL = fileURL
        self.title = title
        self.descriptionText = descriptionText
        self.tags = tags
        self.scheduledAt = scheduledAt
        self.status = scheduledAt.map { .scheduled($0) } ?? .queued
    }
}

@MainActor
@Observable
final class PublishQueue {
    private(set) var items: [PublishItem] = []
    private var timer: Timer?
    let auth = PlatformAuth()
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "publish")

    init() {
        // Local scheduler tick: fire due scheduled items once a minute.
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.fireDue() }
        }
    }

    func enqueue(_ item: PublishItem) {
        items.append(item)
        if item.scheduledAt == nil {
            Task { await publish(itemID: item.id) }
        }
    }

    func remove(id: UUID) {
        items.removeAll { $0.id == id }
    }

    private func fireDue() {
        let now = Date()
        for item in items {
            if case .scheduled(let date) = item.status, date <= now {
                Task { await publish(itemID: item.id) }
            }
        }
    }

    func publish(itemID: UUID) async {
        guard let index = items.firstIndex(where: { $0.id == itemID }) else { return }
        items[index].status = .uploading(0)
        let item = items[index]
        do {
            let url: String?
            switch item.platform {
            case .youtube:
                url = try await YouTubePublisher(auth: auth).upload(item: item) { [weak self] progress in
                    Task { @MainActor in self?.setProgress(itemID: itemID, progress) }
                }
            case .tiktok:
                url = try await TikTokPublisher(auth: auth).upload(item: item) { [weak self] progress in
                    Task { @MainActor in self?.setProgress(itemID: itemID, progress) }
                }
            case .instagram:
                url = try await InstagramPublisher(auth: auth).upload(item: item) { [weak self] progress in
                    Task { @MainActor in self?.setProgress(itemID: itemID, progress) }
                }
            }
            if let index = items.firstIndex(where: { $0.id == itemID }) {
                items[index].status = .published(remoteURL: url)
            }
        } catch {
            if let index = items.firstIndex(where: { $0.id == itemID }) {
                items[index].status = .failed(error.localizedDescription)
            }
            log.error("Publish failed: \(error.localizedDescription)")
        }
    }

    private func setProgress(itemID: UUID, _ progress: Double) {
        guard let index = items.firstIndex(where: { $0.id == itemID }) else { return }
        items[index].status = .uploading(progress)
    }
}

/// OAuth token storage + the ASWebAuthenticationSession dance per platform.
/// Client IDs/secrets are user-supplied (each platform requires an app
/// registration; see docs/DEV_SETUP.md).
final class PlatformAuth: NSObject {
    enum AuthError: LocalizedError {
        case notConfigured(PublishPlatform)
        case notAuthorized(PublishPlatform)

        var errorDescription: String? {
            switch self {
            case .notConfigured(let platform):
                "\(platform.displayName) isn't configured — add the client ID in Settings (requires a \(platform.displayName) developer app)."
            case .notAuthorized(let platform):
                "Sign in to \(platform.displayName) first (Settings → Publishing)."
            }
        }
    }

    private func keychainKey(_ platform: PublishPlatform) -> String {
        "com.aviashkenazi.streamit.publish.\(platform.rawValue)"
    }

    func accessToken(for platform: PublishPlatform) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainKey(platform),
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw AuthError.notAuthorized(platform)
        }
        return token
    }

    /// Whether a token is stored for `platform`. Keychain-backed, so this
    /// reflects exactly what `accessToken(for:)` will find.
    func isAuthorized(_ platform: PublishPlatform) -> Bool {
        (try? accessToken(for: platform)) != nil
    }

    func removeToken(for platform: PublishPlatform) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainKey(platform),
        ]
        SecItemDelete(query as CFDictionary)
    }

    func storeToken(_ token: String, for platform: PublishPlatform) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainKey(platform),
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    /// Runs the OAuth authorization-code flow in a system web session.
    /// verify on Mac: presentation-context wiring for ASWebAuthenticationSession.
    @MainActor
    func authorize(platform: PublishPlatform,
                   authorizationURL: URL,
                   callbackScheme: String,
                   exchangeCode: @escaping (String) async throws -> String) async throws {
        let code: String = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authorizationURL,
                                                     callbackURLScheme: callbackScheme) { url, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let url,
                      let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                          .queryItems?.first(where: { $0.name == "code" })?.value else {
                    continuation.resume(throwing: AuthError.notAuthorized(platform))
                    return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = self
            session.start()
        }
        let token = try await exchangeCode(code)
        storeToken(token, for: platform)
    }
}

extension PlatformAuth: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.mainWindow ?? ASPresentationAnchor()
    }
}
