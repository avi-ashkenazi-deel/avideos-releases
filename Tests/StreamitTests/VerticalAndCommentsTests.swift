import XCTest
@testable import Streamit

/// The vertical canvas's automatic layout, the comment sources' parsing,
/// the on-air card's layout, and the destination file's tolerance.
final class VerticalAdapterTests: XCTestCase {
    let horizontal = CGSize(width: 1920, height: 1080)
    let vertical = CGSize(width: 1080, height: 1920)

    private func pixelAspect(_ t: ElementTransform, _ canvas: CGSize) -> Double {
        Double(t.size.width * canvas.width) / Double(t.size.height * canvas.height)
    }

    func testFullCanvasStaysFullCanvas() {
        let result = VerticalAdapter.adapt(.fullCanvas, from: horizontal, to: vertical)
        XCTAssertEqual(result.transform.size.width, 1)
        XCTAssertEqual(result.transform.size.height, 1)
        XCTAssertEqual(result.contentScale, 1080.0 / 1920.0, accuracy: 0.0001)
    }

    func testPixelAspectIsPreserved() {
        // A circle-ish PiP: 0.2 × 0.3556 of 1920×1080 is a 384×384 square.
        let pip = ElementTransform(center: CGPoint(x: 0.85, y: 0.8),
                                   size: CGSize(width: 0.2, height: 0.35556))
        let result = VerticalAdapter.adapt(pip, from: horizontal, to: vertical)
        XCTAssertEqual(pixelAspect(result.transform, vertical), pixelAspect(pip, horizontal), accuracy: 0.01)
    }

    func testLowerThirdWidensButStaysInside() {
        let lowerThird = ElementTransform(center: CGPoint(x: 0.3, y: 0.85),
                                          size: CGSize(width: 0.5, height: 0.12))
        let result = VerticalAdapter.adapt(lowerThird, from: horizontal, to: vertical).transform
        XCTAssertEqual(result.size.width, 0.8, accuracy: 0.001)   // 0.5 × 1.6
        XCTAssertGreaterThanOrEqual(result.center.x - result.size.width / 2, VerticalAdapter.edgeMargin - 0.0001)
        XCTAssertLessThanOrEqual(result.center.x + result.size.width / 2, 1 - VerticalAdapter.edgeMargin + 0.0001)
        // Mapped into the title-safe band, clear of the phone UI at the bottom.
        XCTAssertLessThanOrEqual(result.center.y + result.size.height / 2, VerticalAdapter.safeBottom + 0.0001)
        XCTAssertGreaterThanOrEqual(result.center.y - result.size.height / 2, VerticalAdapter.safeTop - 0.0001)
    }

    func testWidthCapAndHeightCap() {
        let wide = ElementTransform(center: CGPoint(x: 0.5, y: 0.5), size: CGSize(width: 0.9, height: 0.2))
        XCTAssertLessThanOrEqual(VerticalAdapter.adapt(wide, from: horizontal, to: vertical).transform.size.width,
                                 VerticalAdapter.maxWidthFraction + 0.0001)
        let tall = ElementTransform(center: CGPoint(x: 0.5, y: 0.5), size: CGSize(width: 0.3, height: 0.94))
        XCTAssertLessThanOrEqual(VerticalAdapter.adapt(tall, from: horizontal, to: vertical).transform.size.height,
                                 VerticalAdapter.maxHeightFraction + 0.0001)
    }

    func testOverrideWinsAndScalesContentByWidth() {
        var element = Element(name: "Title", kind: .text(TextContent()),
                              transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.5),
                                                          size: CGSize(width: 0.5, height: 0.1)))
        element.verticalTransform = ElementTransform(center: CGPoint(x: 0.5, y: 0.2),
                                                     size: CGSize(width: 0.9, height: 0.05))
        let placement = RenderPlanCompiler.verticalPlacement(for: element,
                                                             horizontalCanvas: horizontal,
                                                             verticalCanvas: vertical)
        XCTAssertEqual(placement.transform, element.verticalTransform)
        // 0.9 × 1080 = 972 px vs 0.5 × 1920 = 960 px.
        XCTAssertEqual(placement.textReferenceHeight ?? 0, 1080 * 972.0 / 960.0, accuracy: 0.01)
    }

    func testVerticalInterviewStacksPeople() {
        let two = InterviewLayout.verticalFrames(count: 2, style: .grid, spacing: 0.01)
        XCTAssertEqual(two.count, 2)
        XCTAssertEqual(two[0].center.x, 0.5, accuracy: 0.0001)
        XCTAssertLessThan(two[0].center.y, two[1].center.y)
        let four = InterviewLayout.verticalFrames(count: 4, style: .grid, spacing: 0.01)
        XCTAssertEqual(four.count, 4)
        XCTAssertLessThan(four[0].center.x, four[1].center.x)   // two columns beyond three people
        let lead = InterviewLayout.verticalFrames(count: 3, style: .hostLeading, spacing: 0.01)
        XCTAssertGreaterThan(lead[0].size.height, lead[1].size.height)
        XCTAssertEqual(InterviewLayout.verticalFrames(count: 1, style: .grid, spacing: 0.01), [.fullCanvas])
    }
}

final class LiveCommentsTests: XCTestCase {

    // MARK: Twitch

    func testTwitchPrivmsgWithTags() throws {
        let line = "@badge-info=;badges=broadcaster/1;color=#FF4500;display-name=Avi_Live;id=abc-123;mod=0;tmi-sent-ts=1700000000000 :avi_live!avi_live@avi_live.tmi.twitch.tv PRIVMSG #avi_live :hello there\\, chat"
        let message = try XCTUnwrap(TwitchIRC.parse(line))
        XCTAssertEqual(message.command, "PRIVMSG")
        XCTAssertEqual(message.params, ["#avi_live"])
        let comment = try XCTUnwrap(TwitchIRC.comment(from: message, destinationID: nil))
        XCTAssertEqual(comment.id, "tw:abc-123")
        XCTAssertEqual(comment.author, "Avi_Live")
        XCTAssertEqual(comment.authorColorHex, "#FF4500")
        XCTAssertEqual(comment.text, "hello there\\, chat")
        XCTAssertTrue(comment.isOwner)
        XCTAssertEqual(comment.timestamp.timeIntervalSince1970, 1_700_000_000, accuracy: 0.001)
    }

    func testTwitchTagUnescaping() {
        XCTAssertEqual(TwitchIRC.unescapeTag("a\\sb\\:c\\\\d"), "a b;c\\d")
        XCTAssertEqual(TwitchIRC.unescapeTag("plain"), "plain")
    }

    func testTwitchPingAndActionAndNonChat() throws {
        let ping = try XCTUnwrap(TwitchIRC.parse("PING :tmi.twitch.tv"))
        XCTAssertEqual(ping.command, "PING")
        XCTAssertEqual(ping.trailing, "tmi.twitch.tv")

        let action = try XCTUnwrap(TwitchIRC.parse(":bob!bob@bob PRIVMSG #chan :\u{1}ACTION waves\u{1}"))
        XCTAssertEqual(TwitchIRC.comment(from: action, destinationID: nil)?.text, "waves")
        XCTAssertEqual(TwitchIRC.comment(from: action, destinationID: nil)?.author, "bob")

        let join = try XCTUnwrap(TwitchIRC.parse(":justinfan1!justinfan1@justinfan1 JOIN #chan"))
        XCTAssertNil(TwitchIRC.comment(from: join, destinationID: nil))
    }

    func testTwitchChannelNames() {
        XCTAssertEqual(TwitchIRC.channelName(from: "AviLive"), "#avilive")
        XCTAssertEqual(TwitchIRC.channelName(from: "https://www.twitch.tv/avi_live"), "#avi_live")
        XCTAssertEqual(TwitchIRC.channelName(from: "#Avi"), "#avi")
        XCTAssertNil(TwitchIRC.channelName(from: "  "))
        XCTAssertNil(TwitchIRC.channelName(from: "not a channel"))
    }

    // MARK: YouTube

    func testYouTubeChatPage() throws {
        let json = """
        {"pollingIntervalMillis": 6000, "nextPageToken": "NEXT",
         "items": [
          {"id": "m1", "snippet": {"type": "textMessageEvent", "displayMessage": "Hi from Lisbon",
                                   "publishedAt": "2026-10-03T12:00:00.123Z"},
           "authorDetails": {"displayName": "Maya", "isChatModerator": true, "isChatOwner": false}},
          {"id": "m2", "snippet": {"type": "superChatEvent", "displayMessage": "Great show",
                                   "publishedAt": "2026-10-03T12:00:05Z",
                                   "superChatDetails": {"amountDisplayString": "$5.00"}},
           "authorDetails": {"displayName": "Tom"}},
          {"id": "m3", "snippet": {"type": "newSponsorEvent", "displayMessage": "joined"}}
         ]}
        """
        let page = try YouTubeChatPage.decode(Data(json.utf8))
        XCTAssertEqual(page.nextPageToken, "NEXT")
        XCTAssertEqual(page.pollingIntervalMillis, 6000)
        let comments = page.comments(destinationID: nil)
        XCTAssertEqual(comments.map(\.id), ["yt:m1", "yt:m2"])
        XCTAssertEqual(comments[0].author, "Maya")
        XCTAssertTrue(comments[0].isModerator)
        XCTAssertEqual(comments[1].amount, "$5.00")
        XCTAssertEqual(comments[1].platform, .youtube)
    }

    func testYouTubeErrorAdvice() {
        let json: [String: Any] = ["error": ["message": "raw",
                                             "errors": [["reason": "liveStreamingNotEnabled"]]]]
        XCTAssertTrue(YouTubeLiveService.errorMessage(from: json)?.contains("YouTube Studio") == true)
        XCTAssertEqual(YouTubeLiveService.errorMessage(from: ["error": ["message": "raw"]]), "raw")
        XCTAssertNil(YouTubeLiveService.errorMessage(from: [:]))
    }

    // MARK: Store

    @MainActor
    func testStoreDedupesSortsAndNeverFeaturesByItself() {
        let store = CommentsStore()
        let early = LiveComment(id: "a", platform: .twitch, author: "A", text: "one",
                                timestamp: Date(timeIntervalSince1970: 10))
        let late = LiveComment(id: "b", platform: .youtube, author: "B", text: "two",
                               timestamp: Date(timeIntervalSince1970: 20))
        store.ingest([late, early, late])
        XCTAssertEqual(store.comments.map(\.id), ["a", "b"])
        XCTAssertNil(store.featured)

        store.toggleShortlist(late)
        XCTAssertTrue(store.isShortlisted(late))
        store.feature(late)
        XCTAssertEqual(store.featured?.id, "b")
        XCTAssertTrue(store.shownIDs.contains("b"))
        store.hideFeatured()
        XCTAssertNil(store.featured)
        XCTAssertTrue(store.shownIDs.contains("b"))   // the "shown" tick stays
    }

    // MARK: Card

    func testCardLayoutFitsCanvasAndClearsPhoneUI() {
        let comment = LiveComment(id: "x", platform: .youtube, author: "Maya",
                                  text: String(repeating: "word ", count: 120), timestamp: Date())
        let style = CommentCardStyle()
        let h = CommentCard.layout(for: comment, style: style,
                                   canvas: CGSize(width: 1920, height: 1080), orientation: .horizontal)
        XCTAssertTrue(h.messageText.hasSuffix("…"))   // cut to four lines
        XCTAssertLessThanOrEqual(h.box.center.y + h.box.size.height / 2, 0.9001)
        XCTAssertGreaterThan(h.box.center.y - h.box.size.height / 2, 0)

        let v = CommentCard.layout(for: comment, style: style,
                                   canvas: CGSize(width: 1080, height: 1920), orientation: .vertical)
        XCTAssertLessThanOrEqual(v.box.center.y + v.box.size.height / 2, 0.7701)
        XCTAssertEqual(v.textReferenceHeight, 1080)
        XCTAssertEqual(v.box.size.width, 0.88, accuracy: 0.0001)
    }

    func testCardIDsAreStableAndDistinct() {
        let a = CommentCard.identifiers(for: "yt:1")
        XCTAssertEqual(a.box, CommentCard.identifiers(for: "yt:1").box)
        XCTAssertNotEqual(a.box, a.name)
        XCTAssertNotEqual(a.box, CommentCard.identifiers(for: "yt:2").box)
    }

    // MARK: Destinations file

    func testDestinationDecodesWithoutOptionalKeys() throws {
        let json = """
        [{"id": "6A2B4E5C-1111-4222-8333-944455556666", "name": "YouTube", "platform": "youtube",
          "orientation": "horizontal", "tier": "1080p", "serverURL": "rtmp://a.rtmp.youtube.com/live2",
          "isEnabled": true}]
        """
        let decoded = try JSONDecoder().decode([StreamDestination].self, from: Data(json.utf8))
        XCTAssertEqual(decoded.first?.platform, .youtube)
        XCTAssertNil(decoded.first?.twitchChannel)
        XCTAssertFalse(decoded.first?.linkedYouTube ?? true)
    }
}
