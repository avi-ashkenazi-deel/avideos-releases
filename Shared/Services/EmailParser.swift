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

        // Guarantee at least one block so the player always has something to read.
        let finalBlocks = blocks.isEmpty
            ? sentences(from: email.snippet, startIndex: 0)
            : blocks
        return ParsedEmail(email: email, blocks: finalBlocks)
    }

    // MARK: - HTML

    private static let imgRegex = try! NSRegularExpression(
        pattern: "<img\\b[^>]*>", options: [.caseInsensitive]
    )

    private static func parseHTML(_ html: String) -> [ContentBlock] {
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
            let image = InlineImage(
                blockIndex: index,
                remoteURL: attribute("src", in: imgTag).flatMap(resolveImageSource),
                contentID: contentID(from: attribute("src", in: imgTag)),
                altText: attribute("alt", in: imgTag)
            )
            blocks.append(.image(image))
            index += 1

            cursor = match.range.location + match.range.length
        }

        // Trailing text after the last image.
        if cursor < ns.length {
            let tail = ns.substring(with: NSRange(location: cursor, length: ns.length - cursor))
            let tailBlocks = sentences(from: stripTags(tail), startIndex: index)
            blocks.append(contentsOf: tailBlocks)
        }

        return blocks
    }

    /// `src="cid:abc"` references an inline attachment rather than a URL.
    private static func resolveImageSource(_ src: String) -> URL? {
        guard !src.lowercased().hasPrefix("cid:") else { return nil }
        return URL(string: src)
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
            // Matches name="..." or name='...'
            let pattern = "\(name)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')"
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
