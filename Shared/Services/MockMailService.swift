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

    func fetchInbox(limit: Int) async throws -> [Email] {
        // Simulate a little network latency.
        try? await Task.sleep(nanoseconds: 350_000_000)
        return Array(emails.sorted { $0.receivedAt > $1.receivedAt }.prefix(limit))
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
                <p>Hi there,</p>
                <p>Three things worth your attention this week. First, the typography \
                refresh shipped and early feedback is glowing. Second, we finally \
                retired the old icon set. Third, accessibility scores jumped after \
                the contrast pass.</p>
                <p>Here's the new palette in action:</p>
                <img src="https://example.com/palette.png" alt="the new five-color brand palette" />
                <p>Let me know what you think. Reply any time.</p>
                <p>— Maya</p>
                """,
                bodyText: nil
            ),
            Email(
                id: "m2",
                threadId: "t2",
                from: EmailAddress(name: "GitHub", address: "noreply@github.com"),
                subject: "[voiceinbox] CI passed on main",
                snippet: "All checks have passed for the latest commit on main.",
                receivedAt: minutesAgo(40),
                isRead: false,
                bodyHTML: nil,
                bodyText: """
                All checks have passed for commit a1b2c3d on main. The build \
                completed in two minutes and eleven seconds. No new warnings were \
                introduced. You can merge your pull request when ready.
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
                <p>We made it home safe and sound.</p>
                <p>The canyon at sunrise was something else. Here's the view from \
                the rim:</p>
                <img src="https://example.com/canyon.jpg" alt="sunrise over a red rock canyon" />
                <p>And here's your mother pretending she wasn't scared of the edge:</p>
                <img src="https://example.com/mom.jpg" alt="a person standing near a canyon overlook" />
                <p>Call us when you get a chance. Love you.</p>
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
                Good morning. Markets opened steady today after yesterday's \
                volatility. Technology shares led modest gains in early trading. \
                Bond yields were little changed. In company news, two large \
                retailers reported earnings that beat expectations, citing strong \
                online sales. Analysts remain cautious heading into next week's \
                inflation report. That's your brief. Have a productive day.
                """
            )
        ]
    }
}
