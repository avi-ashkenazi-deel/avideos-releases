import Foundation

/// Real Gmail backend over the REST API. Dependency-free: it takes an async
/// token provider (wired to `GoogleAuthSession` on iOS) and talks to the Gmail
/// v1 endpoints directly.
///
/// This path is inactive until OAuth credentials are configured; `AppState`
/// picks the demo backend otherwise.
actor GoogleMailService: MailService {

    private let tokenProvider: @Sendable () async throws -> String
    private var cachedAccount: MailAccount?
    private let base = URL(string: "https://gmail.googleapis.com/gmail/v1/users/me")!

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
        struct LabelList: Decodable {
            struct GLabel: Decodable { let id: String; let name: String; let type: String? }
            let labels: [GLabel]?
        }
        let list: LabelList = try await get(base.appendingPathComponent("labels"))
        return (list.labels ?? []).map { MailLabel(id: $0.id, name: $0.name, type: $0.type) }
    }

    func fetchInbox(labelId: String, query: String?, pageToken: String?, limit: Int) async throws -> EmailPage {
        var comps = URLComponents(url: base.appendingPathComponent("messages"), resolvingAgainstBaseURL: false)!
        var items: [URLQueryItem] = [.init(name: "maxResults", value: String(limit))]
        if let query, !query.isEmpty {
            // Gmail search (matches sender, subject, body); spans all mail.
            items.append(.init(name: "q", value: query))
        } else {
            items.append(.init(name: "labelIds", value: labelId))
        }
        if let pageToken, !pageToken.isEmpty {
            items.append(.init(name: "pageToken", value: pageToken))
        }
        comps.queryItems = items

        let list: MessageList = try await get(comps.url!)
        let ids = (list.messages ?? []).map(\.id)
        // Fetch metadata with bounded concurrency so we don't burst past Gmail's
        // per-second quota (which returns 429) on a cold inbox load.
        let emails = try await mapConcurrently(ids, maxConcurrent: 6) { id in
            try await self.fetchMessage(id: id, full: false)
        }
        return EmailPage(emails: emails.sorted { $0.receivedAt > $1.receivedAt },
                         nextPageToken: list.nextPageToken)
    }

    /// Run `transform` over `items` with at most `maxConcurrent` in flight at once.
    private func mapConcurrently<Input: Sendable, Output: Sendable>(
        _ items: [Input],
        maxConcurrent: Int,
        _ transform: @Sendable @escaping (Input) async throws -> Output
    ) async throws -> [Output] {
        try await withThrowingTaskGroup(of: Output.self) { group in
            var result: [Output] = []
            var index = 0
            let initial = min(maxConcurrent, items.count)
            while index < initial {
                let item = items[index]; index += 1
                group.addTask { try await transform(item) }
            }
            while let output = try await group.next() {
                result.append(output)
                if index < items.count {
                    let item = items[index]; index += 1
                    group.addTask { try await transform(item) }
                }
            }
            return result
        }
    }

    func fetchFullEmail(id: String) async throws -> Email {
        try await fetchMessage(id: id, full: true)
    }

    func markRead(id: String) async throws {
        let url = base.appendingPathComponent("messages/\(id)/modify")
        let body = try JSONSerialization.data(withJSONObject: ["removeLabelIds": ["UNREAD"]])
        _ = try await send(url, method: "POST", body: body)
    }

    func markUnread(id: String) async throws {
        let url = base.appendingPathComponent("messages/\(id)/modify")
        let body = try JSONSerialization.data(withJSONObject: ["addLabelIds": ["UNREAD"]])
        _ = try await send(url, method: "POST", body: body)
    }

    // MARK: - Profile

    private func fetchProfile() async throws -> MailAccount {
        let profile: Profile = try await get(base.appendingPathComponent("profile"))
        let account = MailAccount(provider: .google,
                                  emailAddress: profile.emailAddress,
                                  displayName: profile.emailAddress)
        cachedAccount = account
        return account
    }

    // MARK: - Message fetch + decode

    private func fetchMessage(id: String, full: Bool) async throws -> Email {
        var comps = URLComponents(url: base.appendingPathComponent("messages/\(id)"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = full
            ? [.init(name: "format", value: "full")]
            : [.init(name: "format", value: "metadata"),
               .init(name: "metadataHeaders", value: "From"),
               .init(name: "metadataHeaders", value: "Subject"),
               .init(name: "metadataHeaders", value: "Date")]

        let msg: GmailMessage = try await get(comps.url!)
        let headers = msg.payload?.headerMap ?? [:]
        let (html, text) = full ? msg.payload?.extractBody() ?? (nil, nil) : (nil, nil)

        return Email(
            id: msg.id,
            threadId: msg.threadId,
            from: GoogleMailService.parseAddress(headers["from"] ?? ""),
            subject: headers["subject"] ?? "",
            snippet: msg.snippet?.htmlUnescaped ?? "",
            receivedAt: GoogleMailService.parseDate(headers["date"], internalDate: msg.internalDate),
            isRead: !(msg.labelIds?.contains("UNREAD") ?? false),
            bodyHTML: html,
            bodyText: text
        )
    }

    private static func parseAddress(_ raw: String) -> EmailAddress {
        // Formats: "Name <addr>" or "addr"
        if let open = raw.firstIndex(of: "<"), let close = raw.firstIndex(of: ">"), open < close {
            let name = String(raw[..<open])
                .trimmingCharacters(in: CharacterSet(charactersIn: " \""))
            let addr = String(raw[raw.index(after: open)..<close])
            return EmailAddress(name: name.isEmpty ? nil : name, address: addr)
        }
        return EmailAddress(name: nil, address: raw.trimmingCharacters(in: .whitespaces))
    }

    private static func parseDate(_ header: String?, internalDate: String?) -> Date {
        if let ms = internalDate, let millis = Double(ms) {
            return Date(timeIntervalSince1970: millis / 1000)
        }
        if let header {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
            if let date = formatter.date(from: header) { return date }
        }
        return Date()
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
            // Always hit the network: the app's own MailCache handles offline, and
            // URLSession's shared cache would otherwise serve a stale inbox listing
            // so pull-to-refresh wouldn't show newly arrived mail.
            request.cachePolicy = .reloadIgnoringLocalCacheData
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
            // Rate limiting (429) and transient server errors (5xx) are retried
            // with exponential backoff + jitter, honoring Retry-After if present.
            if (http.statusCode == 429 || (500..<600).contains(http.statusCode)), attempt < maxAttempts {
                let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
                let backoff = retryAfter ?? (pow(2.0, Double(attempt - 1)) * 0.5)
                let jitter = Double.random(in: 0...0.3)
                try await Task.sleep(nanoseconds: UInt64((backoff + jitter) * 1_000_000_000))
                continue
            }
            throw MailServiceError.network("Status \(http.statusCode)")
        }
    }
}

// MARK: - Gmail JSON shapes

private struct MessageList: Decodable {
    struct Ref: Decodable { let id: String }
    let messages: [Ref]?
    let nextPageToken: String?
}

private struct Profile: Decodable { let emailAddress: String }

private struct GmailMessage: Decodable {
    let id: String
    let threadId: String
    let snippet: String?
    let labelIds: [String]?
    let internalDate: String?
    let payload: Payload?
}

private struct Payload: Decodable {
    struct Header: Decodable { let name: String; let value: String }
    struct Body: Decodable { let data: String? }

    let mimeType: String?
    let headers: [Header]?
    let body: Body?
    let parts: [Payload]?

    var headerMap: [String: String] {
        // Gmail payloads can repeat header names (e.g. several `Received:`),
        // so dedupe by keeping the first value — `uniqueKeysWithValues` would
        // trap on a duplicate key and crash the email fetch.
        Dictionary(
            (headers ?? []).map { ($0.name.lowercased(), $0.value) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    /// Walk the MIME tree and pull out the first HTML and plain-text bodies.
    func extractBody() -> (html: String?, text: String?) {
        var html: String?
        var text: String?

        func decode(_ data: String?) -> String? {
            guard let data, let bytes = Data(base64URLEncoded: data) else { return nil }
            return String(data: bytes, encoding: .utf8)
        }

        func walk(_ node: Payload) {
            switch node.mimeType {
            case "text/html" where html == nil: html = decode(node.body?.data)
            case "text/plain" where text == nil: text = decode(node.body?.data)
            default: break
            }
            node.parts?.forEach(walk)
        }
        walk(self)
        return (html, text)
    }
}

private extension String {
    /// Gmail snippets arrive HTML-escaped (&amp; etc.).
    var htmlUnescaped: String {
        replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
    }
}
