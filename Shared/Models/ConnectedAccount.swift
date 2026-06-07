import Foundation

/// A mailbox the user has connected. The OAuth tokens live in the Keychain under
/// `tokenKey`; this metadata is non-secret and persisted so we can list the
/// accounts and switch between them. Saved links / highlights stay shared across
/// accounts (settings are shared too).
struct ConnectedAccount: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let provider: MailAccount.Provider
    var email: String
    var displayName: String
    var tokenKey: String

    init(provider: MailAccount.Provider, email: String, displayName: String) {
        let key = "tokens.\(provider.rawValue).\(email.lowercased())"
        self.id = key
        self.provider = provider
        self.email = email
        self.displayName = displayName
        self.tokenKey = key
    }
}
