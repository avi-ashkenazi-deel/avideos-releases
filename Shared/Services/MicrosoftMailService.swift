import Foundation

/// Outlook / Microsoft 365 backend over Microsoft Graph. Unlike Gmail, Graph
/// returns full message metadata (sender, subject, preview, date) in the list
/// call, so there's no per-message fetch.
actor MicrosoftMailService: MailService {

    private let tokenProvider: @Sendable () async throws -> String
    private var cachedAccount: MailAccount?
    private let base = URL(string: "https://graph.microsoft.com/v1.0")!

    private static let listFields = "id,subject,from,bodyPreview,receivedDateTime,isRead"

    init(tokenProvider: @escaping @Sendable () async throws -> String) {
        self.tokenProvider = tokenProvider
    }

    var account: MailAccount? {
        get async {
            if let cachedAccount { return cachedAccount }
            return try? await fetchProfile()
        }
    }

    // MARK: - MailService

    func fetchLabels() async throws -> [MailLabel] {
        var comps = URLComponents(url: base.appendingPathComponent("me/mailFolders"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "$top", value: "100"), .init(name: "$select", value: "id,displayName")]
        let resp: FolderList = try await get(comps.url!)
        return (resp.value ?? []).map {
            MailLabel(id: $0.id, name: $0.displayName ?? $0.id, type: "user")
        }
    }

    func fetchInbox(labelId: String, query: String?, pageToken: String?, limit: Int) async throws -> EmailPage {
        let url: URL
        if let pageToken, !pageToken.isEmpty, let next = URL(string: pageToken) {
            url = next   // Graph @odata.nextLink is a full URL
        } else if let query, !query.isEmpty {
            var comps = URLComponents(url: base.appendingPathComponent("me/messages"), resolvingAgainstBaseURL: false)!
            comps.queryItems = [
                .init(name: "$search", value: "\"\(query)\""),
                .init(name: "$top", value: String(limit)),
                .init(name: "$select", value: Self.listFields)
            ]
            url = comps.url!
        } else {
            // "INBOX" (our cross-provider default) maps to Graph's well-known folder.
            let folder = labelId == "INBOX" ? "inbox" : labelId
            var comps = URLComponents(url: base.appendingPathComponent("me/mailFolders/\(folder)/messages"),
                                      resolvingAgainstBaseURL: false)!
            comps.queryItems = [
                .init(name: "$top", value: String(limit)),
                .init(name: "$orderby", value: "receivedDateTime desc"),
                .init(name: "$select", value: Self.listFields)
            ]
            url = comps.url!
        }
        let resp: MessageList = try await get(url)
        let emails = (resp.value ?? []).map { $0.toEmail() }
        return EmailPage(emails: emails, nextPageToken: resp.nextLink)
    }

    func fetchFullEmail(id: String) async throws -> Email {
        var comps = URLComponents(url: base.appendingPathComponent("me/messages/\(id)"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "$select", value: Self.listFields + ",body")]
        let msg: GraphMessage = try await get(comps.url!)
        return msg.toEmail()
    }

    func markRead(id: String) async throws { try await patchRead(id: id, isRead: true) }
    func markUnread(id: String) async throws { try await patchRead(id: id, isRead: false) }

    private func patchRead(id: String, isRead: Bool) async throws {
        let url = base.appendingPathComponent("me/messages/\(id)")
        let body = try JSONSerialization.data(withJSONObject: ["isRead": isRead])
        _ = try await send(url, method: "PATCH", body: body)
    }

    // MARK: - Profile

    private func fetchProfile() async throws -> MailAccount {
        struct Me: Decodable { let displayName: String?; let mail: String?; let userPrincipalName: String? }
        let me: Me = try await get(base.appendingPathComponent("me"))
        let email = me.mail ?? me.userPrincipalName ?? ""
        let account = MailAccount(provider: .microsoft,
                                  emailAddress: email,
                                  displayName: me.displayName ?? email)
        cachedAccount = account
        return account
    }

    // MARK: - HTTP

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        let data = try await send(url, method: "GET", body: nil)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw MailServiceError.decoding(error.localizedDescription) }
    }

    @discardableResult
    private func send(_ url: URL, method: String, body: Data?) async throws -> Data {
        let maxAttempts = 4
        var attempt = 0
        while true {
            attempt += 1
            let token = try await tokenProvider()
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let body {
                request.httpBody = body
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw MailServiceError.network("No HTTP response")
            }
            if (200..<300).contains(http.statusCode) { return data }
            if http.statusCode == 401 { throw MailServiceError.notAuthenticated }
            if (http.statusCode == 429 || (500..<600).contains(http.statusCode)), attempt < maxAttempts {
                let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
                let backoff = retryAfter ?? (pow(2.0, Double(attempt - 1)) * 0.5)
                try await Task.sleep(nanoseconds: UInt64((backoff + Double.random(in: 0...0.3)) * 1_000_000_000))
                continue
            }
            throw MailServiceError.network("Status \(http.statusCode)")
        }
    }
}

// MARK: - Graph JSON shapes

private struct FolderList: Decodable {
    struct Folder: Decodable { let id: String; let displayName: String? }
    let value: [Folder]?
}

private struct MessageList: Decodable {
    let value: [GraphMessage]?
    let nextLink: String?
    enum CodingKeys: String, CodingKey { case value; case nextLink = "@odata.nextLink" }
}

private struct GraphMessage: Decodable {
    struct Recipient: Decodable { let emailAddress: Address? }
    struct Address: Decodable { let name: String?; let address: String? }
    struct Body: Decodable { let contentType: String?; let content: String? }

    let id: String
    let subject: String?
    let bodyPreview: String?
    let receivedDateTime: String?
    let isRead: Bool?
    let from: Recipient?
    let body: Body?

    func toEmail() -> Email {
        let addr = from?.emailAddress
        let isHTML = body?.contentType?.lowercased() == "html"
        return Email(
            id: id,
            threadId: id,
            from: EmailAddress(name: addr?.name, address: addr?.address ?? ""),
            subject: subject ?? "",
            snippet: bodyPreview ?? "",
            receivedAt: Self.parseDate(receivedDateTime),
            isRead: isRead ?? false,
            bodyHTML: isHTML ? body?.content : nil,
            bodyText: isHTML ? nil : body?.content
        )
    }

    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parseDate(_ string: String?) -> Date {
        guard let string else { return Date() }
        return formatter.date(from: string)
            ?? ISO8601DateFormatter().date(from: string)
            ?? Date()
    }
}
