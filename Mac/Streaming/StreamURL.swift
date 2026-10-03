import Foundation

/// An RTMP ingest endpoint split the way the protocol needs it: where to
/// connect (host/port/TLS), what to send as `app` and `tcUrl` in `connect`,
/// and the stream name for `publish`.
///
/// Platforms hand out "Server URL" + "Stream key" in two fields; some users
/// paste one URL with the key on the end. Both are accepted.
struct StreamURL: Equatable, Sendable {
    var host: String
    var port: Int
    var usesTLS: Bool
    /// `connect`'s app name: "live2" for YouTube, "app" for Twitch, "rtmp"
    /// for Instagram — whatever sits in the URL path.
    var app: String
    /// The `tcUrl` property of `connect`: scheme://host[:port]/app.
    var tcURL: String
    /// The `publish` name — the stream key (with any query string the
    /// platform put on it, which Instagram does).
    var streamName: String

    enum ParseError: Error, Equatable {
        case notRTMP
        case missingHost
        case missingApp
        case missingKey
    }

    /// - Parameters:
    ///   - server: the platform's "Server URL" (rtmp:// or rtmps://).
    ///   - key: the stream key. When empty, the LAST path component of
    ///     `server` is taken as the key (the paste-one-URL case).
    static func parse(server: String, key: String) throws -> StreamURL {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        let usesTLS: Bool
        let schemeLength: Int
        if lower.hasPrefix("rtmps://") {
            usesTLS = true
            schemeLength = "rtmps://".count
        } else if lower.hasPrefix("rtmp://") {
            usesTLS = false
            schemeLength = "rtmp://".count
        } else {
            throw ParseError.notRTMP
        }

        let rest = String(trimmed.dropFirst(schemeLength))
        let slash = rest.firstIndex(of: "/") ?? rest.endIndex
        let authority = String(rest[rest.startIndex..<slash])
        var path = slash < rest.endIndex ? String(rest[rest.index(after: slash)...]) : ""

        // host[:port] (IPv6 literals are not something an ingest uses).
        var host = authority
        var port = usesTLS ? 443 : 1935
        if let colon = authority.lastIndex(of: ":") {
            host = String(authority[authority.startIndex..<colon])
            if let parsed = Int(authority[authority.index(after: colon)...]) {
                port = parsed
            }
        }
        guard !host.isEmpty else { throw ParseError.missingHost }

        while path.hasSuffix("/") { path.removeLast() }

        var streamName = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if streamName.isEmpty {
            // One URL with the key at the end: split off the last component.
            guard let lastSlash = path.lastIndex(of: "/") else {
                throw path.isEmpty ? ParseError.missingApp : ParseError.missingKey
            }
            streamName = String(path[path.index(after: lastSlash)...])
            path = String(path[path.startIndex..<lastSlash])
        }
        guard !path.isEmpty else { throw ParseError.missingApp }
        guard !streamName.isEmpty else { throw ParseError.missingKey }

        let scheme = usesTLS ? "rtmps" : "rtmp"
        let defaultPort = usesTLS ? 443 : 1935
        let portPart = port == defaultPort ? "" : ":\(port)"
        return StreamURL(host: host,
                         port: port,
                         usesTLS: usesTLS,
                         app: path,
                         tcURL: "\(scheme)://\(host)\(portPart)/\(path)",
                         streamName: streamName)
    }

    /// The URL with the key masked — safe for logs and status text.
    var redactedDescription: String {
        "\(tcURL)/••••\(streamName.suffix(4))"
    }
}
