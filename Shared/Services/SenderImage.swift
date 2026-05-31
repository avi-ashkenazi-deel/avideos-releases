import Foundation
import CryptoKit

/// Builds the ordered list of candidate image URLs for a sender's address — a
/// face (Gravatar) or company logo (Clearbit / favicon). Shared by the inbox
/// avatar and the lock-screen Now Playing artwork.
enum SenderImage {

    /// Generic mail providers whose domain favicon (the Gmail/Outlook logo) isn't
    /// a useful sender image — for these we only try Gravatar.
    static let genericProviders: Set<String> = [
        "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
        "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com",
        "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com"
    ]

    static func candidateURLs(forAddress address: String) -> [URL] {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard trimmed.contains("@") else { return [] }

        var urls: [URL] = []

        // 1. Gravatar (face). `d=404` so it errors instead of returning a default.
        let hash = Insecure.MD5.hash(data: Data(trimmed.utf8))
            .map { String(format: "%02x", $0) }.joined()
        if let gravatar = URL(string: "https://www.gravatar.com/avatar/\(hash)?d=404&s=256") {
            urls.append(gravatar)
        }

        // 2/3. Company logo by domain, unless it's a generic mail provider.
        if let domain = trimmed.split(separator: "@").last.map(String.init),
           domain.contains("."), !genericProviders.contains(domain) {
            if let clearbit = URL(string: "https://logo.clearbit.com/\(domain)?size=256") {
                urls.append(clearbit)
            }
            if let favicon = URL(string: "https://www.google.com/s2/favicons?domain=\(domain)&sz=256") {
                urls.append(favicon)
            }
        }
        return urls
    }
}
