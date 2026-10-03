import Foundation
import os

/// Twitch IRC line parsing (IRCv3 tags), pure so it's unit-tested.
enum TwitchIRC {
    struct Message: Equatable {
        var tags: [String: String]
        var prefix: String?
        var command: String
        var params: [String]
        /// The text after " :" (the chat message for PRIVMSG).
        var trailing: String?
    }

    /// Parses one line ("@tags :prefix COMMAND params :trailing").
    static func parse(_ rawLine: String) -> Message? {
        var line = Substring(rawLine.trimmingCharacters(in: .newlines))
        guard !line.isEmpty else { return nil }

        var tags: [String: String] = [:]
        if line.hasPrefix("@") {
            guard let space = line.firstIndex(of: " ") else { return nil }
            for pair in line[line.index(after: line.startIndex)..<space].split(separator: ";") {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let key = String(parts[0])
                tags[key] = parts.count > 1 ? unescapeTag(String(parts[1])) : ""
            }
            line = line[line.index(after: space)...]
        }

        var prefix: String?
        if line.hasPrefix(":") {
            guard let space = line.firstIndex(of: " ") else { return nil }
            prefix = String(line[line.index(after: line.startIndex)..<space])
            line = line[line.index(after: space)...]
        }

        var trailing: String?
        if let range = line.range(of: " :") {
            trailing = String(line[range.upperBound...])
            line = line[..<range.lowerBound]
        } else if line.hasPrefix(":") {
            trailing = String(line.dropFirst())
            line = ""
        }

        let words = line.split(separator: " ").map(String.init)
        guard let command = words.first else { return nil }
        return Message(tags: tags, prefix: prefix, command: command,
                       params: Array(words.dropFirst()), trailing: trailing)
    }

    /// IRCv3 tag-value escapes: \s space, \: semicolon, \\ backslash, \r, \n.
    static func unescapeTag(_ value: String) -> String {
        guard value.contains("\\") else { return value }
        var result = ""
        var iterator = value.makeIterator()
        while let char = iterator.next() {
            guard char == "\\" else {
                result.append(char)
                continue
            }
            switch iterator.next() {
            case "s": result.append(" ")
            case ":": result.append(";")
            case "\\": result.append("\\")
            case "r": result.append("\r")
            case "n": result.append("\n")
            case let other?: result.append(other)
            case nil: break
            }
        }
        return result
    }

    /// A chat message as a `LiveComment`, or nil for anything else.
    static func comment(from message: Message, destinationID: UUID?) -> LiveComment? {
        guard message.command == "PRIVMSG", var text = message.trailing else { return nil }
        // "/me waves" arrives as CTCP ACTION.
        if text.hasPrefix("\u{1}ACTION "), text.hasSuffix("\u{1}") {
            text = String(text.dropFirst(8).dropLast())
        }
        let login = message.prefix?.split(separator: "!").first.map(String.init) ?? "someone"
        let name = message.tags["display-name"].flatMap { $0.isEmpty ? nil : $0 } ?? login
        let badges = message.tags["badges"] ?? ""
        let sent = message.tags["tmi-sent-ts"].flatMap(Double.init).map { Date(timeIntervalSince1970: $0 / 1000) }
        let id = message.tags["id"] ?? "\(login)-\(sent?.timeIntervalSince1970 ?? Date().timeIntervalSince1970)"
        let bits = message.tags["bits"].flatMap(Int.init)
        return LiveComment(id: "tw:\(id)",
                           platform: .twitch,
                           destinationID: destinationID,
                           author: name,
                           authorColorHex: message.tags["color"].flatMap { $0.isEmpty ? nil : $0 },
                           text: text,
                           timestamp: sent ?? Date(),
                           isModerator: message.tags["mod"] == "1",
                           isOwner: badges.contains("broadcaster/"),
                           amount: bits.map { "\($0) bits" })
    }

    /// "#name", lowercased, from "name", "#Name" or a twitch.tv URL.
    static func channelName(from input: String) -> String? {
        var name = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let slash = name.lastIndex(of: "/") { name = String(name[name.index(after: slash)...]) }
        name = name.trimmingCharacters(in: CharacterSet(charactersIn: "#@"))
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        return "#\(name)"
    }
}

/// Reads a Twitch channel's chat anonymously: Twitch lets any "justinfan"
/// nick join read-only, so there's no login. Reconnects on its own.
@MainActor
final class TwitchChatSource: CommentSource {
    let platform: StreamPlatform = .twitch
    private let channel: String
    private let destinationID: UUID?
    private var task: URLSessionWebSocketTask?
    private var runner: Task<Void, Never>?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "twitch-chat")

    init?(channel: String, destinationID: UUID?) {
        guard let name = TwitchIRC.channelName(from: channel) else { return nil }
        self.channel = name
        self.destinationID = destinationID
    }

    func start(onComments: @escaping @MainActor ([LiveComment]) -> Void,
               onStatus: @escaping @MainActor (CommentSourceStatus) -> Void) {
        runner?.cancel()
        runner = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled, let self {
                onStatus(.connecting)
                do {
                    try await self.session(onComments: onComments, onStatus: onStatus)
                    attempt = 0
                } catch {
                    if Task.isCancelled { break }
                    self.log.error("Twitch chat dropped: \(error.localizedDescription, privacy: .public)")
                }
                if Task.isCancelled { break }
                attempt += 1
                onStatus(.waiting("Reconnecting to Twitch chat…"))
                try? await Task.sleep(for: .seconds(min(30, pow(2, Double(min(attempt, 5))))))
            }
        }
    }

    func stop() {
        runner?.cancel()
        runner = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// One connection's life: log in, join, read until it drops.
    private func session(onComments: @escaping @MainActor ([LiveComment]) -> Void,
                         onStatus: @escaping @MainActor (CommentSourceStatus) -> Void) async throws {
        let socket = URLSession.shared.webSocketTask(with: URL(string: "wss://irc-ws.chat.twitch.tv:443")!)
        task = socket
        socket.resume()
        let nick = "justinfan\(Int.random(in: 10_000...99_999))"
        for line in ["CAP REQ :twitch.tv/tags twitch.tv/commands",
                     "PASS SCHMOOPIIE",
                     "NICK \(nick)",
                     "JOIN \(channel)"] {
            try await socket.send(.string(line))
        }
        while !Task.isCancelled {
            let frame = try await socket.receive()
            let text: String
            switch frame {
            case .string(let string): text = string
            case .data(let data): text = String(decoding: data, as: UTF8.self)
            @unknown default: continue
            }
            var batch: [LiveComment] = []
            for line in text.split(whereSeparator: \.isNewline) {
                guard let message = TwitchIRC.parse(String(line)) else { continue }
                switch message.command {
                case "PING":
                    try await socket.send(.string("PONG :\(message.trailing ?? "tmi.twitch.tv")"))
                case "JOIN", "ROOMSTATE":
                    onStatus(.connected)
                case "RECONNECT":
                    throw URLError(.networkConnectionLost)
                case "NOTICE" where (message.trailing ?? "").lowercased().contains("does not exist"):
                    onStatus(.failed("Twitch channel \(channel) wasn't found."))
                default:
                    if let comment = TwitchIRC.comment(from: message, destinationID: destinationID) {
                        batch.append(comment)
                    }
                }
            }
            if !batch.isEmpty { onComments(batch) }
        }
    }
}
