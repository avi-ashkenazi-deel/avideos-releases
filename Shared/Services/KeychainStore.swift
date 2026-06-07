import Foundation
import Security

/// Minimal Keychain wrapper for small secrets (API key, OAuth tokens).
/// Items are stored per-app (no access group) using a generic-password class.
enum KeychainStore {

    private static let service = "com.voiceinbox.secrets"

    /// Store (or, with `nil`/empty, remove) a string for `account`.
    static func set(_ value: String?, account: String) {
        guard let value, !value.isEmpty else {
            delete(account: account)
            return
        }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(base as CFDictionary)

        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        // ThisDeviceOnly: secrets (OAuth refresh tokens, API key) stay on this
        // device and never migrate via encrypted backup or iCloud Keychain.
        // Still readable after first unlock, so background token refresh works.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }

    enum Account {
        static let elevenLabsAPIKey = "elevenLabsAPIKey"
        static let googleTokens = "google.tokens"
        static let microsoftTokens = "microsoft.tokens"
    }
}
