import Foundation

/// Turns an email body into an ordered list of `ContentBlock`s: sentences to
/// speak, interleaved with the images encountered along the way.
///
/// This is deliberately dependency-free. For HTML we scan for `<img>` tags to
/// preserve image position, strip the remaining markup, decode common entities,
/// and split the text into sentences using Foundation's sentence tokenizer.
enum EmailParser {

    static func parse(_ email: Email) -> ParsedEmail {
        let blocks: [ContentBlock]
        if let html = email.bodyHTML, !html.isEmpty {
            blocks = parseHTML(html)
        } else {
            blocks = sentences(from: email.bodyText ?? email.snippet, startIndex: 0)
        }

        // Drop the boilerplate footer newsletters (Substack et al.) tack on:
        // "Share / Comment / Restack / Upgrade to paid / © … / Subscribe for free…".
        let trimmed = trimTrailingBoilerplate(blocks)
        // Don't let trimming wipe everything (e.g. a body that's all footer).
        let kept = trimmed.isEmpty ? blocks : trimmed

        // Guarantee at least one block so the player always has something to read.
        let finalBlocks = kept.isEmpty
            ? sentences(from: email.snippet, startIndex: 0)
            : kept
        return ParsedEmail(email: email, blocks: finalBlocks)
    }

    // MARK: - Trailing boilerplate

    /// Trim the run of footer lines at the very end of the email — the share /
    /// comment / subscribe / copyright rows. Only trims from the end and stops at
    /// the first real sentence (or any image), so mid-body text is never touched.
    private static func trimTrailingBoilerplate(_ blocks: [ContentBlock]) -> [ContentBlock] {
        var end = blocks.count
        while end > 0, case .sentence(let s) = blocks[end - 1], isFooterLine(s.text) {
            end -= 1
        }
        return Array(blocks[0..<end])
    }

    /// Short UI labels that appear as their own line in newsletter footers.
    private static let footerExactLines: Set<String> = [
        "share", "comment", "comments", "like", "likes", "restack", "subscribe",
        "subscribe now", "unsubscribe", "follow", "view in browser", "open in app",
        "read in app", "get the app", "start writing", "leave a comment",
        "share this post", "upgrade to paid", "pledge", "give a gift subscription"
    ]

    /// Phrases that, appearing in a trailing line, mark it as footer regardless of
    /// length (Substack's standard sign-off / legal / promo lines).
    private static let footerMarkers: [String] = [
        "is the home for great culture", "subscribe for free to receive",
        "to receive new posts and support", "collection notice", "privacy ∙ terms",
        "privacy · terms", "© 20", "you're a free subscriber",
        "you’re a free subscriber", "you're currently a free subscriber",
        "you’re currently a free subscriber", "this post is for paid subscribers",
        "upgrade to paid"
    ]

    private static func isFooterLine(_ text: String) -> Bool {
        let trimmedPunct = CharacterSet(charactersIn: ".,!?:;·•|-–—()[]")
        let t = text.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: trimmedPunct)
            .trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return true }
        if footerExactLines.contains(t) { return true }
        return footerMarkers.contains { t.contains($0) }
    }

    // MARK: - HTML

    private static let imgRegex = try! NSRegularExpression(
        pattern: "<img\\b[^>]*>", options: [.caseInsensitive]
    )

    /// `<style>`/`<script>`/`<head>` blocks and comments carry no spoken content,
    /// but real-world (esp. marketing) email HTML packs tens of KB of CSS/JS into
    /// them. Left in, that text floods the sentence tokenizer — garbage on screen
    /// and a long main-thread stall. Strip them before anything else.
    private static let nonContentRegex = try! NSRegularExpression(
        pattern: "<(script|style|head)\\b[^>]*>[\\s\\S]*?</\\1>|<!--[\\s\\S]*?-->",
        options: [.caseInsensitive]
    )

    private static func stripNonContent(_ html: String) -> String {
        let ns = html as NSString
        return nonContentRegex.stringByReplacingMatches(
            in: html,
            range: NSRange(location: 0, length: ns.length),
            withTemplate: " "
        )
    }

    private static func parseHTML(_ rawHTML: String) -> [ContentBlock] {
        let html = stripNonContent(rawHTML)
        var blocks: [ContentBlock] = []
        var index = 0
        let ns = html as NSString
        var cursor = 0

        let matches = imgRegex.matches(in: html, range: NSRange(location: 0, length: ns.length))
        for match in matches {
            // Text before this image.
            let textRange = NSRange(location: cursor, length: match.range.location - cursor)
            let textChunk = ns.substring(with: textRange)
            let chunkBlocks = sentences(from: stripTags(textChunk), startIndex: index)
            blocks.append(contentsOf: chunkBlocks)
            index += chunkBlocks.count

            // The image itself.
            let imgTag = ns.substring(with: match.range)
            cursor = match.range.location + match.range.length

            // Drop spacers, tracking pixels, and the rows of tiny social/footer
            // icons that newsletters (Substack, CNBC, …) pile up — they'd just be
            // announced as "there's an image here" over and over.
            if isDecorative(imgTag) { continue }

            let url = resolveBestSource(from: imgTag)
            let cid = contentID(from: attribute("src", in: imgTag))
            // Nothing we can actually show (empty/unsupported source) — skip it
            // rather than announce a blank image.
            if url == nil, cid == nil { continue }

            let image = InlineImage(
                blockIndex: index,
                remoteURL: url,
                contentID: cid,
                altText: attribute("alt", in: imgTag)
            )
            blocks.append(.image(image))
            index += 1
        }

        // Trailing text after the last image.
        if cursor < ns.length {
            let tail = ns.substring(with: NSRange(location: cursor, length: ns.length - cursor))
            let tailBlocks = sentences(from: stripTags(tail), startIndex: index)
            blocks.append(contentsOf: tailBlocks)
        }

        return blocks
    }

    /// Best loadable image URL for an `<img>`. Marketing/newsletter HTML often
    /// lazy-loads: the real URL sits in `data-src`/`srcset` while plain `src` is a
    /// 1×1 placeholder or `data:` URI. Prefer the real ones, take the largest
    /// `srcset` candidate, normalize protocol-relative `//host/x.png`, and only
    /// accept http(s) (so `cid:`/`data:` fall through to the content-id path).
    private static func resolveBestSource(from tag: String) -> URL? {
        func httpURL(_ raw: String?) -> URL? {
            guard let raw else { return nil }
            var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.hasPrefix("//") { s = "https:" + s }
            guard let url = URL(string: s),
                  let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                return nil
            }
            return url
        }
        // "urlA 320w, urlB 640w" / "urlA 1x, urlB 2x" → last (largest) candidate.
        func fromSrcset(_ raw: String?) -> URL? {
            guard let last = raw?.split(separator: ",").last else { return nil }
            return httpURL(last.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init))
        }
        return httpURL(attribute("data-src", in: tag))
            ?? fromSrcset(attribute("data-srcset", in: tag))
            ?? fromSrcset(attribute("srcset", in: tag))
            ?? httpURL(attribute("src", in: tag))
    }

    /// True for images that carry no spoken/visual value: hidden elements, 1×1
    /// spacers/tracking pixels, and the small icons (≤ ~64px) common in footers.
    private static func isDecorative(_ tag: String) -> Bool {
        if let style = attribute("style", in: tag)?.lowercased(),
           style.contains("display:none") || style.contains("display: none")
            || style.contains("visibility:hidden") || style.contains("visibility: hidden") {
            return true
        }
        // Social / share / subscribe buttons (Substack et al.) — UI controls, not
        // content — usually carry a tell-tale alt even without small dimensions.
        if let alt = attribute("alt", in: tag)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           uiControlAlts.contains(alt) {
            return true
        }
        let w = pixelDimension("width", in: tag)
        let h = pixelDimension("height", in: tag)
        if let w, w <= 2 { return true }
        if let h, h <= 2 { return true }
        if let maxDim = [w, h].compactMap({ $0 }).max(), maxDim < 64 { return true }
        return false
    }

    private static let uiControlAlts: Set<String> = [
        "share", "comment", "comments", "like", "likes", "restack", "subscribe",
        "subscribe now", "unsubscribe", "follow", "view in browser", "open in app",
        "twitter", "x", "facebook", "instagram", "linkedin", "youtube", "threads",
        "tiktok", "pinterest", "whatsapp", "telegram", "app store", "google play"
    ]

    /// A pixel dimension from a `width`/`height` attribute (quoted or not) or an
    /// inline `style`. Percentages (e.g. width="100%") return nil — unknown, keep.
    private static func pixelDimension(_ name: String, in tag: String) -> Int? {
        func firstInt(_ pattern: String, in string: String) -> Int? {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
            let ns = string as NSString
            guard let m = regex.firstMatch(in: string, range: NSRange(location: 0, length: ns.length)),
                  m.range(at: 1).location != NSNotFound else { return nil }
            return Int(ns.substring(with: m.range(at: 1)))
        }
        // width=48 / width="48" / width="48px" — but not when it's a percentage.
        if let attr = attribute(name, in: tag), attr.contains("%") { /* percentage: skip */ }
        else if let value = firstInt("(?<![\\w-])\(name)\\s*=\\s*[\"']?(\\d+)", in: tag) { return value }
        // style="width:48px"
        if let style = attribute("style", in: tag) {
            return firstInt("(?<![\\w-])\(name)\\s*:\\s*(\\d+)\\s*px", in: style)
        }
        return nil
    }

    private static func contentID(from src: String?) -> String? {
        guard let src, src.lowercased().hasPrefix("cid:") else { return nil }
        return String(src.dropFirst(4))
    }

    private static let attrRegexCache = NSCache<NSString, NSRegularExpression>()

    private static func attribute(_ name: String, in tag: String) -> String? {
        let key = name as NSString
        let regex: NSRegularExpression
        if let cached = attrRegexCache.object(forKey: key) {
            regex = cached
        } else {
            // Matches name="..." or name='...'. The leading look-behind keeps
            // `src` from matching `data-src`/`srcset` and `width` from `max-width`.
            let pattern = "(?<![\\w-])\(name)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')"
            regex = try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
            attrRegexCache.setObject(regex, forKey: key)
        }
        let ns = tag as NSString
        guard let m = regex.firstMatch(in: tag, range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        for i in 1...2 where m.range(at: i).location != NSNotFound {
            return decodeEntities(ns.substring(with: m.range(at: i)))
        }
        return nil
    }

    private static let tagRegex = try! NSRegularExpression(pattern: "<[^>]+>", options: [])

    /// Strip remaining tags. Block-level tags become spaces so sentences don't
    /// run together; everything else is removed.
    private static func stripTags(_ html: String) -> String {
        let ns = html as NSString
        let spaced = tagRegex.stringByReplacingMatches(
            in: html,
            range: NSRange(location: 0, length: ns.length),
            withTemplate: " "
        )
        return decodeEntities(spaced)
    }

    // MARK: - Entities

    private static let entityMap: [String: String] = [
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
        "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—",
        "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘",
        "&ldquo;": "“", "&rdquo;": "”"
    ]

    private static func decodeEntities(_ s: String) -> String {
        var result = s
        for (entity, value) in entityMap {
            result = result.replacingOccurrences(of: entity, with: value)
        }
        // Numeric entities like &#8217;
        if let numeric = try? NSRegularExpression(pattern: "&#(\\d+);") {
            let ns = result as NSString
            let matches = numeric.matches(in: result, range: NSRange(location: 0, length: ns.length)).reversed()
            for m in matches {
                let code = ns.substring(with: m.range(at: 1))
                if let scalarValue = UInt32(code), let scalar = Unicode.Scalar(scalarValue) {
                    result = (result as NSString).replacingCharacters(in: m.range, with: String(scalar))
                }
            }
        }
        return result
    }

    // MARK: - Sentences

    /// Split free text into `Sentence` blocks, numbering them from `startIndex`.
    static func sentences(from text: String, startIndex: Int) -> [ContentBlock] {
        let cleaned = text
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return [] }

        var result: [ContentBlock] = []
        var index = startIndex
        cleaned.enumerateSubstrings(in: cleaned.startIndex..<cleaned.endIndex, options: .bySentences) { substring, _, _, _ in
            let trimmed = substring?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty else { return }
            result.append(.sentence(Sentence(blockIndex: index, text: trimmed)))
            index += 1
        }

        // Fallback if the tokenizer produced nothing (e.g. no terminal punctuation).
        if result.isEmpty {
            result.append(.sentence(Sentence(blockIndex: startIndex, text: cleaned)))
        }
        return result
    }
}
