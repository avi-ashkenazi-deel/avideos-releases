import Foundation

/// Shared logic for playing an RSS feed item in the app-wide player: resolves the
/// article content (handling aggregator self-links like Techmeme) and opens it
/// with feed-aware auto-advance. Used both by the Feeds list and by notification
/// taps that deep-link to a specific item.
enum FeedPlayback {

    @MainActor
    static func open(_ item: RSSItem, player: EmailPlayerViewModel, store: FeedStore) {
        // Titles-only: read just each headline, so there's no separate spoken
        // "From <feed>. <title>." intro on top of a body that's also the title —
        // the title *is* the whole item.
        let titlesOnly = AppSettings.shared.feedsTitlesOnly
        Task {
            let email = await playableEmail(for: item, store: store)
            player.open(
                email: email,
                isLocal: true,
                // Read the feed/title up front — for many items the headline is the
                // only real information, so it's spoken before the body. In
                // titles-only mode the body already is the title, so skip the intro.
                announce: !titlesOnly,
                markReadOverride: { [weak store] emailID in
                    store?.markRead(itemID(fromEmailID: emailID))
                },
                // Auto-advance: when one article finishes, load the next unread item.
                nextLocalProvider: { emailID in
                    guard let next = store.nextUnread(after: itemID(fromEmailID: emailID))
                    else { return nil }
                    return await playableEmail(for: next, store: store)
                },
                // Reached the end with nothing left unread — celebrate + exit.
                onQueueFinished: { [weak player] in player?.celebrateFeedFinish = true }
            )
        }
    }

    /// Build a fully-loaded `Email` for a feed item: prefer inline content; else
    /// fetch the real article (resolving aggregator self-links to their source);
    /// else fall back to the item's own summary.
    @MainActor
    static func playableEmail(for item: RSSItem, store: FeedStore) async -> Email {
        let feed = store.feed(for: item.feedID)
        let feedTitle = feed?.title ?? "Feed"
        // Titles-only: don't fetch or read the body — build an item whose whole
        // content is its headline, so playback reads the title and stops.
        if AppSettings.shared.feedsTitlesOnly {
            return item.makeEmail(feedTitle: feedTitle, fullHTML: "<p>\(escapeHTML(item.title))</p>")
        }
        if let html = item.contentHTML, html.count > 400 {
            return item.makeEmail(feedTitle: feedTitle)
        }
        let feedHost = FeedStore.normHost(feed?.siteURL?.host ?? feed?.url.host)
        let isSelfLink = FeedStore.normHost(item.link?.host) == feedHost && feedHost != nil
        let articleURL = isSelfLink ? item.sourceURL : item.link
        if let articleURL {
            let full = try? await ArticleExtractor.fetch(articleURL)
            return item.makeEmail(feedTitle: feedTitle, fullHTML: full?.html)
        }
        return item.makeEmail(feedTitle: feedTitle)
    }

    /// The feed item id behind a played email id (emails are keyed "rss-<itemID>").
    static func itemID(fromEmailID emailID: String) -> String {
        emailID.hasPrefix("rss-") ? String(emailID.dropFirst(4)) : emailID
    }

    /// Escape a plain-text title so it's safe to drop into the title-only HTML
    /// body (a stray `&`/`<`/`>` in a headline would otherwise break parsing).
    private static func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
