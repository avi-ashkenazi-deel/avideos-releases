import Foundation
import CryptoKit
import Security

/// OAuth configuration for the Google sign-in flow. Fill these in after creating
/// an iOS OAuth client in the Google Cloud console. `clientID` looks like
/// `1234-abcd.apps.googleusercontent.com`; the redirect URI is its reverse.
struct GoogleOAuthConfig {
    var clientID: String
    var redirectScheme: String   // e.g. "com.googleusercontent.apps.1234-abcd"
    var scopes: [String]

    var redirectURI: String { "\(redirectScheme):/oauth2redirect" }

    /// Read-only mail access plus the user's email/profile for display.
    static let gmailReadModify = [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
    ]

    /// Placeholder until you add credentials. `isConfigured` gates whether the
    /// app offers the real Google path or falls back to the demo inbox.
    static let placeholder = GoogleOAuthConfig(
        clientID: "REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com",
        redirectScheme: "com.googleusercontent.apps.REPLACE_WITH_REVERSED_CLIENT_ID",
        scopes: gmailReadModify
    )

    var isConfigured: Bool { !clientID.hasPrefix("REPLACE_WITH") }
}

/// OAuth token bundle returned by Google's token endpoint.
struct GoogleTokens: Codable {
    var accessToken: String
    var refreshToken: String?
    var expiresAt: Date

    var isExpired: Bool { Date() >= expiresAt.addingTimeInterval(-60) }

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case expiresAt
    }

    init(accessToken: String, refreshToken: String?, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken)
        if let expiresIn = try c.decodeIfPresent(Double.self, forKey: .expiresIn) {
            expiresAt = Date().addingTimeInterval(expiresIn)
        } else if let stored = try c.decodeIfPresent(Date.self, forKey: .expiresAt) {
            expiresAt = stored
        } else {
            expiresAt = Date()
        }
    }

    // Explicit encoder: the `expiresIn` CodingKey has no matching property
    // (it's only read from Google's response), which blocks synthesis.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accessToken, forKey: .accessToken)
        try c.encodeIfPresent(refreshToken, forKey: .refreshToken)
        try c.encode(expiresAt, forKey: .expiresAt)
    }
}

/// PKCE helper: generates the verifier/challenge pair Google requires for
/// native app OAuth (no client secret on device).
enum PKCE {
    static func makeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedString()
    }

    static func challenge(for verifier: String) -> String {
        let hash = SHA256.hash(data: Data(verifier.utf8))
        return Data(hash).base64URLEncodedString()
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decode Gmail's base64url message bodies (URL-safe, often unpadded).
    init?(base64URLEncoded string: String) {
        var s = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        self.init(base64Encoded: s)
    }
}
