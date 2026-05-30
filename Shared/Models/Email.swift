import Foundation

/// A single email address with an optional display name (e.g. "Jane Doe <jane@x.com>").
struct EmailAddress: Codable, Hashable, Sendable {
    var name: String?
    var address: String

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return address
    }

    /// First initial, used for the avatar bubble in the inbox list.
    var initial: String {
        String(displayName.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }
}

/// An email as fetched from the provider. The raw `bodyHTML` / `bodyText` are
/// turned into a sequence of readable `ContentBlock`s by `EmailParser`.
struct Email: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let threadId: String
    var from: EmailAddress
    var subject: String
    var snippet: String
    var receivedAt: Date
    var isRead: Bool

    /// Exactly one of these is expected to be present. HTML is preferred when
    /// available because it carries inline-image markers.
    var bodyHTML: String?
    var bodyText: String?

    var subjectOrFallback: String {
        subject.isEmpty ? "(no subject)" : subject
    }
}
