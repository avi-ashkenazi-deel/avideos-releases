import Foundation

/// In-memory mail backend with realistic sample messages — including emails that
/// contain images — so the entire listening experience is demoable without any
/// OAuth setup. This is the default backend until Google credentials are wired up.
actor MockMailService: MailService {

    private var emails: [Email]
    private let mockAccount = MailAccount(
        provider: .demo,
        emailAddress: "you@example.com",
        displayName: "Demo Inbox"
    )

    init() {
        self.emails = MockMailService.seed()
    }

    var account: MailAccount? { mockAccount }

    func fetchInbox(labelId: String, query: String?, pageToken: String?, limit: Int) async throws -> EmailPage {
        // Simulate a little network latency. The demo ignores the label and
        // returns the same sample set for any folder.
        try? await Task.sleep(nanoseconds: 350_000_000)
        var result = emails.sorted { $0.receivedAt > $1.receivedAt }
        if let query, !query.isEmpty {
            let q = query.lowercased()
            result = result.filter {
                $0.subject.lowercased().contains(q)
                    || $0.from.displayName.lowercased().contains(q)
                    || $0.from.address.lowercased().contains(q)
            }
        }
        return EmailPage(emails: Array(result.prefix(limit)), nextPageToken: nil)
    }

    func fetchLabels() async throws -> [MailLabel] {
        [
            MailLabel(id: "INBOX", name: "INBOX", type: "system"),
            MailLabel(id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system"),
            MailLabel(id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system"),
            MailLabel(id: "Newsletters", name: "Newsletters", type: "user")
        ]
    }

    func fetchFullEmail(id: String) async throws -> Email {
        guard let email = emails.first(where: { $0.id == id }) else {
            throw MailServiceError.decoding("Unknown message \(id)")
        }
        return email
    }

    func markRead(id: String) async throws {
        guard let idx = emails.firstIndex(where: { $0.id == id }) else { return }
        emails[idx].isRead = true
    }

    func markUnread(id: String) async throws {
        guard let idx = emails.firstIndex(where: { $0.id == id }) else { return }
        emails[idx].isRead = false
    }

    // MARK: - Sample data

    private static func seed() -> [Email] {
        let now = Date()
        func minutesAgo(_ m: Int) -> Date { now.addingTimeInterval(-Double(m) * 60) }

        return [
            Email(
                id: "m1",
                threadId: "t1",
                from: EmailAddress(name: "Maya Chen", address: "maya@designweekly.com"),
                subject: "Your weekly design digest",
                snippet: "Three things worth your attention this week, plus a look at the new color trends…",
                receivedAt: minutesAgo(12),
                isRead: false,
                bodyHTML: """
                <p>Hi there, and welcome to another edition of the design digest. \
                It has been a genuinely busy week across the studio, so grab a \
                coffee and settle in, because there is quite a lot to get through \
                and I want to make sure none of it slips past you.</p>
                <p>The first big update is that the typography refresh finally \
                shipped to production on Tuesday afternoon. We had been sitting on \
                this change for the better part of two months, carefully testing \
                it across every screen size we support, and the early feedback has \
                been overwhelmingly positive. Readers are telling us that long \
                articles feel noticeably less tiring to get through, and our \
                average time on page has crept up by almost fifteen percent since \
                the change went live. That is exactly the kind of quiet, \
                structural improvement that rarely gets celebrated but makes a real \
                difference to the people who use the product every day.</p>
                <p>The second thing I want to mention is that we have at long last \
                retired the old icon set. Some of those icons had been with us \
                since the very first version of the app, and there was a certain \
                sentimental attachment to them, but they had drifted badly out of \
                step with the rest of the visual language. The new set is cleaner, \
                more consistent in its stroke weight, and far easier to recognize \
                at small sizes. Here is the new palette in action so you can see \
                how the colours and icons work together:</p>
                <img src="https://example.com/palette.png" alt="the new five-color brand palette with sample icons" />
                <p>The third update is about accessibility, and honestly this is \
                the one I am proudest of. After a thorough contrast audit, we went \
                through every primary surface in the app and nudged the colours \
                until they comfortably cleared the recommended contrast ratios. \
                Our automated accessibility score jumped from the low seventies \
                into the mid nineties, and more importantly, the app is simply \
                easier to read for everyone, not just people with low vision.</p>
                <p>Looking ahead to next week, we are going to start exploring a \
                dark mode variant of the new palette, and I would love your input \
                on that as it takes shape. If you have strong feelings about dark \
                mode, now is the time to share them. As always, just hit reply and \
                tell me what is on your mind. I read every single response.</p>
                <p>Thanks for reading, and have a wonderful rest of your week.</p>
                <p>— Maya</p>
                """,
                bodyText: nil
            ),
            Email(
                id: "m2",
                threadId: "t2",
                from: EmailAddress(name: "Priya Nair", address: "priya@northwind.io"),
                subject: "Recap and next steps from today's planning call",
                snippet: "Thanks everyone for a productive session. Here's the summary and who owns what…",
                receivedAt: minutesAgo(40),
                isRead: false,
                bodyHTML: nil,
                bodyText: """
                Hi team, thank you all for a genuinely productive planning call this \
                morning. I know these sessions can run long, so I appreciate \
                everyone staying focused and bringing real opinions to the table. \
                I wanted to write up a clear recap while it is all still fresh, so \
                that nobody has to rely on memory and we all leave with the same \
                understanding of what comes next.

                First, we agreed that the highest priority for this quarter is \
                shipping the onboarding redesign. We have heard from support that a \
                large share of new users drop off before they ever reach the core \
                experience, and we believe a smoother, more guided first run can \
                meaningfully move that number. Daniel will own the flow design and \
                aims to have clickable prototypes ready for review by the end of \
                next week.

                Second, we discussed the recurring performance complaints on older \
                devices. This has been bubbling up for a while, and we decided it \
                deserves dedicated time rather than being squeezed in between other \
                work. Sofia will lead a short investigation to identify the worst \
                offenders, and she will report back with a prioritized list before \
                we commit to specific fixes.

                Third, on the topic of hiring, we are moving forward with two open \
                roles on the platform team. If you know strong candidates, please \
                send them my way, because referrals continue to be our best source \
                of great people by a wide margin.

                Finally, a small but important reminder: please keep your task \
                statuses up to date in the tracker. When everything is current, \
                these meetings get shorter and we spend our time discussing real \
                decisions instead of chasing updates. Thanks again, everyone. Reach \
                out any time if something here does not match your understanding.
                """
            ),
            Email(
                id: "m3",
                threadId: "t3",
                from: EmailAddress(name: "Dad", address: "dad@family.net"),
                subject: "Photos from the trip!",
                snippet: "We made it home. Here are a couple of shots from the canyon…",
                receivedAt: minutesAgo(90),
                isRead: false,
                bodyHTML: """
                <p>Well, we made it home safe and sound late last night, tired but \
                very happy, and already missing the quiet of the desert. Your \
                mother slept for almost the entire flight, which tells you just how \
                much walking we did over the past week. I wanted to send you a few \
                pictures before the memories start to blur together.</p>
                <p>The drive out was longer than the map promised, but the moment we \
                reached the rim it was instantly worth every mile. We got up before \
                dawn on the second morning specifically to catch the sunrise, and I \
                am so glad we dragged ourselves out of bed, because the light was \
                absolutely unreal. Here is the view from the rim just as the sun \
                came up over the far wall:</p>
                <img src="https://example.com/canyon.jpg" alt="sunrise over a red rock canyon" />
                <p>We hiked partway down one of the trails in the afternoon, taking \
                it slow and stopping often, and the change in the rock colours as \
                the day went on was something photographs can barely capture. Your \
                mother, who as you know is not exactly fond of heights, was a very \
                good sport about the whole thing. Here she is pretending she was \
                not the least bit nervous standing near the overlook:</p>
                <img src="https://example.com/mom.jpg" alt="a person standing near a canyon overlook, smiling nervously" />
                <p>On the last evening we sat outside the little cabin we rented and \
                watched the stars come out, and there were more of them than I have \
                seen in years. It made us both think about how rarely we slow down \
                enough at home to look up. Anyway, we would love to hear how you \
                are doing. Give us a call when you get a chance, and come visit \
                soon. We love you very much.</p>
                <p>— Dad</p>
                """,
                bodyText: nil
            ),
            Email(
                id: "m4",
                threadId: "t4",
                from: EmailAddress(name: "The Daily Brief", address: "news@dailybrief.com"),
                subject: "Markets steady as tech leads gains",
                snippet: "A calm open after yesterday's volatility. Here's what matters before lunch.",
                receivedAt: minutesAgo(180),
                isRead: true,
                bodyHTML: nil,
                bodyText: """
                Good morning, and welcome to your daily brief. Here is what you need \
                to know before lunch, distilled into a few minutes of listening.

                Markets opened steady today after yesterday's bout of volatility \
                left investors rattled and looking for direction. Technology shares \
                led modest gains in early trading, with several of the largest \
                names recovering a portion of the ground they lost in the previous \
                session. Bond yields were little changed, suggesting that traders \
                are content to wait for fresh economic data before making any big \
                moves in either direction.

                In company news, two large national retailers reported quarterly \
                earnings that comfortably beat expectations. Both pointed to \
                surprisingly strong online sales and better than anticipated \
                margins, and both nudged their guidance for the rest of the year \
                slightly higher. Their shares rose in pre-market trading, and the \
                results lifted sentiment across the broader retail sector.

                On the economic front, analysts remain cautious heading into next \
                week's closely watched inflation report. A reading that comes in \
                hotter than forecast could revive worries about interest rates \
                staying higher for longer, while a softer number would likely be \
                welcomed as a sign that price pressures continue to ease.

                Overseas, European markets were mixed, and trading in Asia was \
                relatively quiet overnight ahead of a public holiday in several \
                major economies. Oil prices ticked up slightly on supply concerns, \
                while gold held steady.

                That is your brief for this morning. We will be back tomorrow with \
                another update. Until then, have a productive and healthy day.
                """
            )
        ]
    }
}
