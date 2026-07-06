import Foundation

/// Fetches a web page and extracts a readable title + content HTML, so a saved
/// article can be read aloud and cached for offline listening.
///
/// This is a dependency-free, heuristic "reader mode": it picks the most
/// article-like region of the page (`<article>` / `<main>` / `<body>`), drops
/// chrome (nav/header/footer/aside/forms), and keeps the inner HTML — including
/// `<img>` tags, which `EmailParser` later turns into inline image stops. It
/// won't match a full Readability implementation on messy pages, but it gives a
/// clean spoken transcript for the large majority of articles.
enum ArticleExtractor {

    struct Result: Sendable {
        let title: String
        let siteName: String?
        let excerpt: String?
        /// Cleaned content HTML, ready to hand to `EmailParser`.
        let html: String
    }

    enum ExtractError: LocalizedError {
        case badStatus(Int)
        case notHTML
        case empty

        var errorDescription: String? {
            switch self {
            case .badStatus(let code): return "The site returned status \(code)."
            case .notHTML: return "That link isn't a readable web page."
            case .empty: return "Couldn't find any readable text on the page."
            }
        }
    }

    /// Short-fused session: a slow/hung site caps out at 15s instead of the
    /// shared session's 60s, so opening an article never hangs long — callers
    /// fall back to the item's summary.
    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 15
        cfg.timeoutIntervalForResource = 25
        return URLSession(configuration: cfg)
    }()

    static func fetch(_ url: URL) async throws -> Result {
        var request = URLRequest(url: url)
        // X / Twitter redirect normal browser fetches to a bogus deep-link scheme
        // (so we get nothing), but they still serve a link-preview card — with the
        // tweet text in og:description — to crawler user-agents. Use one for those
        // hosts; a normal browser UA everywhere else.
        let userAgent = isSocialCardHost(url.host)
            ? "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
            : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) HearIt/1.0"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw ExtractError.badStatus(http.statusCode)
        }
        if let mime = response.mimeType, !mime.contains("html") {
            throw ExtractError.notHTML
        }

        let fullHTML = decodeHTML(data, response: response)
        guard !fullHTML.isEmpty else { throw ExtractError.empty }

        let title = extractTitle(from: fullHTML) ?? url.host ?? url.absoluteString
        let siteName = metaContent(property: "og:site_name", in: fullHTML) ?? url.host
        let excerpt = metaContent(name: "description", in: fullHTML)
            ?? metaContent(property: "og:description", in: fullHTML)
            ?? metaContent(name: "twitter:description", in: fullHTML)

        var content = extractContentHTML(from: fullHTML)
        if content.replacingOccurrences(of: " ", with: "").isEmpty {
            // No article region we could extract. Common for JS-only apps (X /
            // Twitter, many SPAs), paywalls, and bare link-preview shells: the real
            // text is rendered by JavaScript we don't run. Rather than fail the save
            // outright, fall back to the page's own summary (og/twitter description)
            // so there's at least something readable — e.g. a tweet's text.
            if let summary = excerpt?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                content = "<p>\(escapeText(summary))</p>"
            } else {
                throw ExtractError.empty
            }
        }

        return Result(title: title, siteName: siteName, excerpt: excerpt, html: content)
    }

    /// Hosts that hide their content from browser fetches but serve an
    /// og:description card to crawlers (so we fetch them as a crawler).
    private static func isSocialCardHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "x.com" || host == "twitter.com" || host == "mobile.twitter.com"
            || host.hasSuffix(".x.com") || host.hasSuffix(".twitter.com")
    }

    /// Minimal HTML escaping for text we inject into a fallback `<p>`.
    private static func escapeText(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    // MARK: - Decoding

    private static func decodeHTML(_ data: Data, response: URLResponse) -> String {
        if let encodingName = response.textEncodingName {
            let cf = CFStringConvertIANACharSetNameToEncoding(encodingName as CFString)
            if cf != kCFStringEncodingInvalidId {
                let ns = CFStringConvertEncodingToNSStringEncoding(cf)
                if let s = String(data: data, encoding: String.Encoding(rawValue: ns)) { return s }
            }
        }
        return String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
    }

    // MARK: - Metadata

    private static func extractTitle(from html: String) -> String? {
        if let og = metaContent(property: "og:title", in: html), !og.isEmpty { return og }
        if let m = firstMatch("<title[^>]*>([\\s\\S]*?)</title>", in: html, group: 1) {
            let title = decodeEntitiesAndCollapse(m)
            return title.isEmpty ? nil : title
        }
        return nil
    }

    private static func metaContent(name: String, in html: String) -> String? {
        metaContent(attribute: "name", value: name, in: html)
    }

    private static func metaContent(property: String, in html: String) -> String? {
        metaContent(attribute: "property", value: property, in: html)
    }

    /// Match `<meta name|property="value" ... content="...">` in either attribute order.
    private static func metaContent(attribute: String, value: String, in html: String) -> String? {
        let v = NSRegularExpression.escapedPattern(for: value)
        let patterns = [
            "<meta[^>]*\\b\(attribute)\\s*=\\s*[\"']\(v)[\"'][^>]*\\bcontent\\s*=\\s*[\"']([^\"']*)[\"']",
            "<meta[^>]*\\bcontent\\s*=\\s*[\"']([^\"']*)[\"'][^>]*\\b\(attribute)\\s*=\\s*[\"']\(v)[\"']"
        ]
        for pattern in patterns {
            if let m = firstMatch(pattern, in: html, group: 1) {
                let decoded = decodeEntitiesAndCollapse(m)
                if !decoded.isEmpty { return decoded }
            }
        }
        return nil
    }

    // MARK: - Content region

    private static func extractContentHTML(from html: String) -> String {
        let stripped = stripNonContent(html)
        let region = firstRegion(stripped, tag: "article")
            ?? firstRegion(stripped, tag: "main")
            ?? bodyRegion(stripped)
            ?? stripped
        return removeChrome(region)
    }

    /// Inner HTML of the first `<tag>…</tag>` block, if present.
    private static func firstRegion(_ html: String, tag: String) -> String? {
        firstMatch("<\(tag)\\b[^>]*>([\\s\\S]*?)</\(tag)>", in: html, group: 1)
    }

    private static func bodyRegion(_ html: String) -> String? {
        firstRegion(html, tag: "body")
    }

    /// Drop obvious non-article containers so navigation/footer text isn't read.
    private static func removeChrome(_ html: String) -> String {
        replacingMatches(
            "<(nav|header|footer|aside|form)\\b[^>]*>[\\s\\S]*?</\\1>",
            in: html, with: " "
        )
    }

    private static func stripNonContent(_ html: String) -> String {
        replacingMatches(
            "<(script|style|head|noscript|svg)\\b[^>]*>[\\s\\S]*?</\\1>|<!--[\\s\\S]*?-->",
            in: html, with: " "
        )
    }

    // MARK: - Regex helpers

    private static func firstMatch(_ pattern: String, in text: String, group: Int) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let ns = text as NSString
        guard let m = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              m.range(at: group).location != NSNotFound else {
            return nil
        }
        return ns.substring(with: m.range(at: group))
    }

    private static func replacingMatches(_ pattern: String, in text: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return text
        }
        let ns = text as NSString
        return regex.stringByReplacingMatches(
            in: text, range: NSRange(location: 0, length: ns.length), withTemplate: template
        )
    }

    /// Lightweight entity decode + whitespace collapse for short metadata strings.
    private static func decodeEntitiesAndCollapse(_ s: String) -> String {
        s.replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
