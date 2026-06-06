import Foundation

/// A Gmail label — which doubles as a "folder" (user labels) or an inbox
/// category (the system `CATEGORY_*` labels like Promotions/Updates).
struct MailLabel: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let name: String
    /// "system" or "user".
    var type: String?

    var isUserLabel: Bool { type == "user" }

    /// Friendly name for the picker (system labels come back ALL-CAPS).
    var displayName: String {
        switch id {
        case "INBOX": return "Inbox"
        case "STARRED": return "Starred"
        case "IMPORTANT": return "Important"
        case "CATEGORY_PERSONAL": return "Primary"
        case "CATEGORY_SOCIAL": return "Social"
        case "CATEGORY_PROMOTIONS": return "Promotions"
        case "CATEGORY_UPDATES": return "Updates"
        case "CATEGORY_FORUMS": return "Forums"
        default:
            // User labels can be nested with "/"; show the leaf.
            return name.split(separator: "/").last.map(String.init) ?? name
        }
    }

    /// Whether this label makes sense to "listen to" (hide Sent/Drafts/Spam/etc.).
    var isListenable: Bool {
        if isUserLabel { return true }
        let allowed: Set<String> = [
            "INBOX", "STARRED", "IMPORTANT",
            "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
            "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"
        ]
        return allowed.contains(id)
    }

    /// Sort order: Inbox first, then categories, then user labels A–Z.
    var sortRank: Int {
        switch id {
        case "INBOX": return 0
        case "CATEGORY_PERSONAL": return 1
        case "CATEGORY_UPDATES": return 2
        case "CATEGORY_PROMOTIONS": return 3
        case "CATEGORY_FORUMS": return 4
        case "CATEGORY_SOCIAL": return 5
        case "STARRED": return 6
        case "IMPORTANT": return 7
        default: return 100
        }
    }

    static let inbox = MailLabel(id: "INBOX", name: "INBOX", type: "system")
}
