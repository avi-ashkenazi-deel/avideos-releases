import Foundation

/// Dependency-free RSS 2.0 / Atom parser built on `XMLParser`.
/// Returns the feed's title/site link and its items.
final class FeedParser: NSObject, XMLParserDelegate {

    struct Result: Sendable {
        var title: String?
        var siteURL: URL?
        var items: [Item] = []
    }

    struct Item: Sendable {
        var guid: String?
        var title = ""
        var link: URL?
        var summary: String?
        var contentHTML: String?
        var published: Date?
    }

    enum FeedError: LocalizedError {
        case notAFeed
        var errorDescription: String? { "That URL doesn't look like an RSS/Atom feed." }
    }

    static func parse(data: Data) throws -> Result {
        let parser = FeedParser()
        let xml = XMLParser(data: data)
        xml.delegate = parser
        xml.parse()
        guard parser.sawFeedRoot else { throw FeedError.notAFeed }
        var result = parser.result
        // Drop items with no title at all (some feeds emit empty stubs).
        result.items.removeAll { $0.title.isEmpty && $0.summary == nil }
        return result
    }

    // MARK: - Parser state

    private var result = Result()
    private var sawFeedRoot = false
    private var inItem = false
    private var current = Item()
    private var path: [String] = []
    private var text = ""
    private var atomLinkHref: URL?   // <link href=…> in the current scope

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                qualifiedName: String?, attributes: [String: String] = [:]) {
        let element = name.lowercased()
        path.append(element)
        text = ""

        switch element {
        case "rss", "feed", "rdf:rdf":
            sawFeedRoot = true
        case "item", "entry":
            inItem = true
            current = Item()
        case "link" where attributes["href"] != nil:
            // Atom-style <link href="…">; prefer rel="alternate" (or no rel).
            let rel = attributes["rel"] ?? "alternate"
            if rel == "alternate", let url = URL(string: attributes["href"]!) {
                if inItem { current.link = current.link ?? url }
                else { result.siteURL = result.siteURL ?? url }
            }
        case "enclosure":
            break
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }
    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        text += String(data: CDATABlock, encoding: .utf8) ?? ""
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?,
                qualifiedName: String?) {
        let element = name.lowercased()
        defer { path.removeLast(); text = "" }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)

        if inItem {
            switch element {
            case "item", "entry":
                inItem = false
                result.items.append(current)
            case "title":
                current.title = value
            case "link":
                if current.link == nil, let url = URL(string: value), url.scheme != nil {
                    current.link = url
                }
            case "guid", "id":
                current.guid = value.isEmpty ? nil : value
            case "description", "summary":
                if current.summary == nil { current.summary = value }
            case "content:encoded", "content":
                if !value.isEmpty { current.contentHTML = value }
            case "pubdate", "published", "updated", "dc:date":
                if current.published == nil { current.published = Self.date(from: value) }
            default:
                break
            }
        } else {
            switch element {
            case "title":
                // Only the channel/feed-level title (rss>channel>title or feed>title).
                let tail = Array(path.suffix(2))
                if result.title == nil, !value.isEmpty,
                   tail == ["channel", "title"] || tail == ["feed", "title"] {
                    result.title = value
                }
            case "link":
                if result.siteURL == nil, let url = URL(string: value), url.scheme != nil {
                    result.siteURL = url
                }
            default:
                break
            }
        }
    }

    // MARK: - Dates (RFC 822 + ISO 8601, the two formats feeds actually use)

    private static let rfc822: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
        return f
    }()
    private static let rfc822NoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "dd MMM yyyy HH:mm:ss Z"
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func date(from raw: String) -> Date? {
        rfc822.date(from: raw)
            ?? rfc822NoDay.date(from: raw)
            ?? iso.date(from: raw)
            ?? isoFractional.date(from: raw)
    }
}
