import Foundation

/// A spoken sentence within an email body.
struct Sentence: Identifiable, Codable, Hashable, Sendable {
    let id: String
    /// Position among *all* content blocks (sentences + images), so the UI can
    /// scroll to and highlight the active block regardless of type.
    let blockIndex: Int
    let text: String
    /// List nesting level (0 = not in a list, 1 = top-level bullet, 2 = nested…),
    /// used to indent the sentence on screen.
    let listDepth: Int
    /// The bullet/number to show before the sentence (e.g. "•", "◦", "2."). Empty
    /// when the sentence isn't the first line of a list item. Display-only — never
    /// spoken, and kept out of `text` so the word-by-word highlight stays aligned.
    let bulletMarker: String

    init(id: String = UUID().uuidString, blockIndex: Int, text: String,
         listDepth: Int = 0, bulletMarker: String = "") {
        self.id = id
        self.blockIndex = blockIndex
        self.text = text
        self.listDepth = listDepth
        self.bulletMarker = bulletMarker
    }
}

/// An image encountered while reading the email. We don't OCR it; we surface it
/// on screen and either pause for the listener to look, or just announce it.
struct InlineImage: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let blockIndex: Int
    /// Remote URL for the image, when the email references one.
    var remoteURL: URL?
    /// `cid:` content-id for an image attached inline to the message.
    var contentID: String?
    var altText: String?

    /// What the synthesizer says when it reaches the image.
    var spokenDescription: String {
        if let altText, !altText.isEmpty {
            return "There's an image here: \(altText)."
        }
        return "There's an image here."
    }

    init(id: String = UUID().uuidString,
         blockIndex: Int,
         remoteURL: URL? = nil,
         contentID: String? = nil,
         altText: String? = nil) {
        self.id = id
        self.blockIndex = blockIndex
        self.remoteURL = remoteURL
        self.contentID = contentID
        self.altText = altText
    }
}

/// An email body, flattened into an ordered list of things to read or show.
enum ContentBlock: Identifiable, Hashable, Sendable {
    case sentence(Sentence)
    case image(InlineImage)

    var id: String {
        switch self {
        case .sentence(let s): return s.id
        case .image(let i): return i.id
        }
    }

    var blockIndex: Int {
        switch self {
        case .sentence(let s): return s.blockIndex
        case .image(let i): return i.blockIndex
        }
    }

    var isImage: Bool {
        if case .image = self { return true }
        return false
    }

    /// The text the synthesizer should speak for this block.
    var spokenText: String {
        switch self {
        case .sentence(let s): return s.text
        case .image(let i): return i.spokenDescription
        }
    }
}

/// A hyperlink found in an email/article body, surfaced so the listener can see
/// where a link goes — and save it to read later — without tapping through.
struct EmailLink: Identifiable, Hashable, Sendable {
    var id: String { url.absoluteString }
    /// The link's visible anchor text (falls back to the host when empty).
    let text: String
    let url: URL

    /// Host without a leading "www.", for a compact secondary label.
    var displayHost: String {
        let host = url.host ?? url.absoluteString
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// A fully parsed email ready to be played.
struct ParsedEmail: Identifiable, Sendable {
    var id: String { email.id }
    let email: Email
    let blocks: [ContentBlock]
    /// Links discovered in the body, in order of appearance, deduped by URL.
    let links: [EmailLink]
    /// This email's own "read it on the web" link — the one in `links` whose
    /// visible text matches the subject line (nearly every newsletter, Substack
    /// included, makes its headline a link to the web version of the post).
    /// Nil for plain emails with no such link. Lets the reader's link button
    /// jump straight to *this* post instead of listing every link in the body.
    let canonicalURL: URL?

    init(email: Email, blocks: [ContentBlock], links: [EmailLink] = [], canonicalURL: URL? = nil) {
        self.email = email
        self.blocks = blocks
        self.links = links
        self.canonicalURL = canonicalURL
    }

    var sentenceCount: Int {
        blocks.reduce(0) { $0 + ($1.isImage ? 0 : 1) }
    }
}
