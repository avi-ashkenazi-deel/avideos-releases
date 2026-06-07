import Foundation

#if os(iOS)
import AuthenticationServices

/// Drives the interactive Google OAuth flow with PKCE via
/// `ASWebAuthenticationSession`, then exchanges/refreshes tokens against
/// Google's token endpoint. No client secret is stored on device.
///
/// Tokens are persisted in the Keychain **per account** (keyed by the caller),
/// so several mailboxes can be connected at once.
@MainActor
final class GoogleAuthSession: NSObject {

    private let config: GoogleOAuthConfig
    private var webSession: ASWebAuthenticationSession?

    private static let authEndpoint = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    private static let tokenEndpoint = URL(string: "https://oauth2.googleapis.com/token")!

    init(config: GoogleOAuthConfig = .placeholder) {
        self.config = config
    }

    /// Present the consent screen and return tokens. The caller persists them
    /// under the right per-account key (we don't know the email until after).
    func authenticate() async throws -> GoogleTokens {
        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(for: verifier)

        var comps = URLComponents(url: Self.authEndpoint, resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            .init(name: "client_id", value: config.clientID),
            .init(name: "redirect_uri", value: config.redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "scope", value: config.scopes.joined(separator: " ")),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "access_type", value: "offline"),
            .init(name: "prompt", value: "consent")
        ]

        let callbackURL = try await presentWebSession(url: comps.url!)
        guard let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value else {
            throw MailServiceError.network("No authorization code returned")
        }
        return try await Self.exchange(code: code, verifier: verifier, config: config)
    }

    // MARK: - Per-account token storage

    static func tokens(key: String) -> GoogleTokens? {
        guard let json = KeychainStore.get(account: key), let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(GoogleTokens.self, from: data)
    }

    static func store(_ tokens: GoogleTokens?, key: String) {
        if let tokens, let data = try? JSONEncoder().encode(tokens), let json = String(data: data, encoding: .utf8) {
            KeychainStore.set(json, account: key)
        } else {
            KeychainStore.delete(account: key)
        }
    }

    /// A valid access token for the account stored under `key`, refreshing if needed.
    static func validAccessToken(key: String, config: GoogleOAuthConfig = .placeholder) async throws -> String {
        guard let tokens = tokens(key: key) else { throw MailServiceError.notAuthenticated }
        if !tokens.isExpired { return tokens.accessToken }
        guard let refreshToken = tokens.refreshToken else { throw MailServiceError.notAuthenticated }
        var refreshed = try await refresh(refreshToken: refreshToken, config: config)
        // Google omits the refresh token on refresh; keep the old one.
        if refreshed.refreshToken == nil { refreshed.refreshToken = refreshToken }
        store(refreshed, key: key)
        return refreshed.accessToken
    }

    // MARK: - Token endpoint

    private static func exchange(code: String, verifier: String, config: GoogleOAuthConfig) async throws -> GoogleTokens {
        try await postToken([
            "client_id": config.clientID,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": config.redirectURI
        ])
    }

    private static func refresh(refreshToken: String, config: GoogleOAuthConfig) async throws -> GoogleTokens {
        try await postToken([
            "client_id": config.clientID,
            "refresh_token": refreshToken,
            "grant_type": "refresh_token"
        ])
    }

    private static func postToken(_ params: [String: String]) async throws -> GoogleTokens {
        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = params
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? "")" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw MailServiceError.network("Token request failed: \(String(data: data, encoding: .utf8) ?? "")")
        }
        do {
            return try JSONDecoder().decode(GoogleTokens.self, from: data)
        } catch {
            throw MailServiceError.decoding(error.localizedDescription)
        }
    }

    // MARK: - Web session

    private func presentWebSession(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: config.redirectScheme
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: error ?? MailServiceError.network("Sign-in cancelled"))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.webSession = session
            session.start()
        }
    }
}

extension GoogleAuthSession: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        ASPresentationAnchor()
    }
}

extension CharacterSet {
    static let urlQueryValueAllowed: CharacterSet = {
        var set = CharacterSet.urlQueryAllowed
        set.remove(charactersIn: "+&=")
        return set
    }()
}
#endif
