import Foundation

/// OAuth configuration for signing in with a Microsoft / Outlook account.
/// Fill `clientID` in after registering a free app in the Azure portal (Azure
/// Active Directory → App registrations → New registration → "Mobile and
/// desktop applications" with redirect URI `msauth.<bundle-id>://auth`).
struct MicrosoftOAuthConfig {
    var clientID: String
    var redirectScheme: String   // e.g. "msauth.com.aviashkenazi.voiceinbox"
    var scopes: [String]
    /// "common" lets both personal (outlook.com) and work/school accounts in.
    var tenant: String = "common"

    var redirectURI: String { "\(redirectScheme)://auth" }

    /// Read/modify mail (to mark read) + the signed-in user's profile, plus a
    /// refresh token.
    static let mailScopes = [
        "openid", "profile", "email", "offline_access",
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/User.Read"
    ]

    static let placeholder = MicrosoftOAuthConfig(
        clientID: "REPLACE_WITH_AZURE_CLIENT_ID",
        redirectScheme: "msauth.com.aviashkenazi.voiceinbox",
        scopes: mailScopes
    )

    var isConfigured: Bool { !clientID.hasPrefix("REPLACE_WITH") }
}
