import Foundation
import AppKit
import AuthenticationServices
import CryptoKit
import Security
import Observation
import os

/// Google sign-in for the YouTube Live features (creating broadcasts, reading
/// live chat). PKCE with an "iOS" type OAuth client: no client secret exists,
/// the redirect is the client id reversed, and nothing is stored but the
/// tokens, which live in the Keychain.
///
/// The client id is the host's own (Settings → Streaming), because YouTube's
/// API quota and consent screen belong to whoever registers the app. See
/// docs/DEV_SETUP.md, "YouTube Live account".
@MainActor
@Observable
final class GoogleOAuth: NSObject {
    static let shared = GoogleOAuth()

    struct Tokens: Codable, Sendable {
        var accessToken: String
        var refreshToken: String?
        var expiresAt: Date

        var isExpired: Bool { Date() >= expiresAt.addingTimeInterval(-60) }
    }

    enum AuthError: LocalizedError {
        case notConfigured
        case notConnected
        case cancelled
        case tokenRequest(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                "Add your Google OAuth client ID in Settings → Streaming first."
            case .notConnected:
                "Connect your YouTube account in Settings → Streaming."
            case .cancelled:
                "Sign-in was cancelled."
            case .tokenRequest(let detail):
                "Google sign-in failed: \(detail)"
            }
        }
    }

    static let youTubeScopes = ["https://www.googleapis.com/auth/youtube.force-ssl"]

    private static let authEndpoint = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    private static let tokenEndpoint = URL(string: "https://oauth2.googleapis.com/token")!
    private static let keychain = KeychainStore(service: "com.aviashkenazi.streamit.google", account: "youtube")
    private static let clientIDKey = "streaming.googleClientID"
    private static let channelNameKey = "streaming.youTubeChannelName"

    @ObservationIgnored private var webSession: ASWebAuthenticationSession?
    @ObservationIgnored private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "google")

    /// Bumped on connect/disconnect so SwiftUI views re-read `isConnected`.
    private(set) var revision = 0

    // MARK: Configuration

    /// "1234-abcd.apps.googleusercontent.com".
    var clientID: String {
        get { UserDefaults.standard.string(forKey: Self.clientIDKey) ?? "" }
        set {
            UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines),
                                      forKey: Self.clientIDKey)
        }
    }

    var isConfigured: Bool { clientID.hasSuffix(".apps.googleusercontent.com") }

    /// "com.googleusercontent.apps.1234-abcd": the client id reversed.
    var redirectScheme: String {
        let prefix = clientID.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
        return "com.googleusercontent.apps.\(prefix)"
    }

    var redirectURI: String { "\(redirectScheme):/oauth2redirect" }

    var isConnected: Bool {
        _ = revision   // observation hook: the Keychain itself isn't observable
        return Self.storedTokens() != nil
    }

    /// The YouTube channel the tokens belong to, for the Settings row.
    var channelName: String? {
        get {
            _ = revision
            return UserDefaults.standard.string(forKey: Self.channelNameKey)
        }
        set { UserDefaults.standard.set(newValue, forKey: Self.channelNameKey) }
    }

    // MARK: Connect / disconnect

    func connect() async throws {
        guard isConfigured else { throw AuthError.notConfigured }
        let verifier = Self.makeVerifier()
        var components = URLComponents(url: Self.authEndpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: Self.youTubeScopes.joined(separator: " ")),
            .init(name: "code_challenge", value: Self.challenge(for: verifier)),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "access_type", value: "offline"),
            .init(name: "prompt", value: "consent"),
        ]
        let callback = try await presentWebSession(url: components.url!)
        guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value else {
            throw AuthError.tokenRequest("no authorization code came back")
        }
        let tokens = try await postToken([
            "client_id": clientID,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirectURI,
        ])
        Self.store(tokens)
        revision += 1
        channelName = try? await YouTubeLiveService.channelTitle()
        revision += 1
        log.notice("YouTube account connected")
    }

    func disconnect() {
        if let token = Self.storedTokens()?.refreshToken ?? Self.storedTokens()?.accessToken,
           let url = URL(string: "https://oauth2.googleapis.com/revoke?token=\(token)") {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            URLSession.shared.dataTask(with: request).resume()
        }
        Self.store(nil)
        channelName = nil
        revision += 1
    }

    /// A valid access token, refreshed when needed. Google leaves the
    /// refresh token out of refresh responses, so the old one is kept.
    func accessToken() async throws -> String {
        guard let tokens = Self.storedTokens() else { throw AuthError.notConnected }
        if !tokens.isExpired { return tokens.accessToken }
        guard let refreshToken = tokens.refreshToken else { throw AuthError.notConnected }
        var refreshed = try await postToken([
            "client_id": clientID,
            "refresh_token": refreshToken,
            "grant_type": "refresh_token",
        ])
        if refreshed.refreshToken == nil { refreshed.refreshToken = refreshToken }
        Self.store(refreshed)
        return refreshed.accessToken
    }

    // MARK: Storage

    private static func storedTokens() -> Tokens? {
        guard let json = try? keychain.readString(), let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Tokens.self, from: data)
    }

    private static func store(_ tokens: Tokens?) {
        if let tokens, let data = try? JSONEncoder().encode(tokens),
           let json = String(data: data, encoding: .utf8) {
            try? keychain.writeString(json)
        } else {
            try? keychain.delete()
        }
    }

    // MARK: Token endpoint

    private struct TokenResponse: Decodable {
        var access_token: String
        var refresh_token: String?
        var expires_in: Double?
    }

    private func postToken(_ params: [String: String]) async throws -> Tokens {
        var request = URLRequest(url: Self.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "+&=")
        request.httpBody = params
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
            .data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AuthError.tokenRequest(String(data: data, encoding: .utf8) ?? "HTTP error")
        }
        let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
        return Tokens(accessToken: decoded.access_token,
                      refreshToken: decoded.refresh_token,
                      expiresAt: Date().addingTimeInterval(decoded.expires_in ?? 3600))
    }

    // MARK: PKCE

    private static func makeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64URL(Data(bytes))
    }

    private static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: Web session

    private func presentWebSession(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url,
                                                     callbackURLScheme: redirectScheme) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError,
                          error.code == .canceledLogin {
                    continuation.resume(throwing: AuthError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? AuthError.cancelled)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            session.start()
        }
    }
}

extension GoogleOAuth: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow ?? NSApplication.shared.mainWindow ?? ASPresentationAnchor()
    }
}
