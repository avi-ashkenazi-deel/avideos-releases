import Foundation

#if os(iOS)
import AuthenticationServices

/// Microsoft identity-platform OAuth (PKCE) via `ASWebAuthenticationSession`,
/// then token exchange/refresh against the v2.0 token endpoint. Mirrors
/// `GoogleAuthSession`; reuses `GoogleTokens` as the standard OAuth token bundle.
@MainActor
final class MicrosoftAuthSession: NSObject {

    private let config: MicrosoftOAuthConfig
    private var webSession: ASWebAuthenticationSession?

    private var authEndpoint: URL {
        URL(string: "https://login.microsoftonline.com/\(config.tenant)/oauth2/v2.0/authorize")!
    }
    private var tokenEndpoint: URL {
        URL(string: "https://login.microsoftonline.com/\(config.tenant)/oauth2/v2.0/token")!
    }

    init(config: MicrosoftOAuthConfig = .placeholder) {
        self.config = config
    }

    var storedTokens: GoogleTokens? {
        get {
            guard let json = KeychainStore.get(account: KeychainStore.Account.microsoftTokens),
                  let data = json.data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(GoogleTokens.self, from: data)
        }
        set {
            if let newValue,
               let data = try? JSONEncoder().encode(newValue),
               let json = String(data: data, encoding: .utf8) {
                KeychainStore.set(json, account: KeychainStore.Account.microsoftTokens)
            } else {
                KeychainStore.delete(account: KeychainStore.Account.microsoftTokens)
            }
        }
    }

    func signOut() { storedTokens = nil }

    func authenticate() async throws -> GoogleTokens {
        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(for: verifier)

        var comps = URLComponents(url: authEndpoint, resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            .init(name: "client_id", value: config.clientID),
            .init(name: "redirect_uri", value: config.redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "response_mode", value: "query"),
            .init(name: "scope", value: config.scopes.joined(separator: " ")),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "prompt", value: "select_account")
        ]

        let callbackURL = try await presentWebSession(url: comps.url!)
        guard let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value else {
            throw MailServiceError.network("No authorization code returned")
        }

        let tokens = try await exchange(code: code, verifier: verifier)
        storedTokens = tokens
        return tokens
    }

    func validAccessToken() async throws -> String {
        guard let tokens = storedTokens else { throw MailServiceError.notAuthenticated }
        if !tokens.isExpired { return tokens.accessToken }
        guard let refreshToken = tokens.refreshToken else { throw MailServiceError.notAuthenticated }
        let refreshed = try await refresh(refreshToken: refreshToken)
        storedTokens = refreshed
        return refreshed.accessToken
    }

    // MARK: - Token endpoint

    private func exchange(code: String, verifier: String) async throws -> GoogleTokens {
        try await postToken([
            "client_id": config.clientID,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": config.redirectURI,
            "scope": config.scopes.joined(separator: " ")
        ])
    }

    private func refresh(refreshToken: String) async throws -> GoogleTokens {
        var tokens = try await postToken([
            "client_id": config.clientID,
            "refresh_token": refreshToken,
            "grant_type": "refresh_token",
            "scope": config.scopes.joined(separator: " ")
        ])
        if tokens.refreshToken == nil { tokens.refreshToken = refreshToken }
        return tokens
    }

    private func postToken(_ params: [String: String]) async throws -> GoogleTokens {
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

extension MicrosoftAuthSession: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        ASPresentationAnchor()
    }
}
#endif
