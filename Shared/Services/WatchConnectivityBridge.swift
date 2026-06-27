import Foundation
import Combine

#if canImport(WatchConnectivity)
import WatchConnectivity

/// Lightweight bridge between the phone and the watch. Used to keep highlights
/// in sync and to relay player commands from the watch to the phone.
@MainActor
final class WatchConnectivityBridge: NSObject, ObservableObject {

    static let shared = WatchConnectivityBridge()

    enum Message {
        case highlightCaptured(Highlight)
        case command(PlayerCommand)
    }

    enum PlayerCommand: String, Codable {
        case play, pause, nextSentence, previousSentence, highlight, nextItem
    }

    /// Set by whichever side wants to react to incoming messages.
    var onHighlight: ((Highlight) -> Void)?
    var onCommand: ((PlayerCommand) -> Void)?
    /// Phone-side: the watch asked to change playback speed (0.5...2.5×).
    var onSpeed: ((Double) -> Void)?
    /// The ElevenLabs API key lives in the per-app Keychain, so the phone relays
    /// the cloud-voice config to the watch (over the encrypted WatchConnectivity
    /// channel) so the watch can use the same voice. `(key, voiceID, enabled)`.
    var onElevenLabsConfig: ((String, String, Bool) -> Void)?

    @Published private(set) var isReachable = false
    /// Watch-side: the latest snapshot of what the phone is playing, so the watch
    /// remote can mirror it. `nil` until the phone sends its first update.
    @Published private(set) var nowPlaying: NowPlayingState?

    private var session: WCSession? {
        WCSession.isSupported() ? WCSession.default : nil
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        session.activate()
    }

    func send(command: PlayerCommand) {
        sendPayload(["command": command.rawValue])
    }

    func send(highlight: Highlight) {
        guard let data = try? JSONEncoder.iso.encode(highlight) else { return }
        sendPayload(["highlight": data])
    }

    /// Phone → watch: the current player snapshot (mirrored by the watch remote).
    func send(nowPlaying state: NowPlayingState) {
        guard let data = try? JSONEncoder.iso.encode(state) else { return }
        sendPayload(["nowPlaying": data])
    }

    /// Watch → phone: change playback speed.
    func send(speed: Double) {
        sendPayload(["speed": speed])
    }

    /// Relay the ElevenLabs cloud-voice config to the counterpart (phone → watch).
    func syncElevenLabsConfig(key: String, voiceID: String, enabled: Bool) {
        sendPayload(["elevenKey": key, "elevenVoiceID": voiceID, "elevenEnabled": enabled])
    }

    private func sendPayload(_ payload: [String: Any]) {
        guard let session, session.activationState == .activated else { return }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        } else {
            // Best-effort background delivery.
            try? session.updateApplicationContext(payload)
        }
    }

    private func handle(_ payload: [String: Any]) {
        if let raw = payload["command"] as? String, let command = PlayerCommand(rawValue: raw) {
            onCommand?(command)
        }
        if let data = payload["highlight"] as? Data,
           let highlight = try? JSONDecoder.iso.decode(Highlight.self, from: data) {
            onHighlight?(highlight)
        }
        if let data = payload["nowPlaying"] as? Data,
           let state = try? JSONDecoder.iso.decode(NowPlayingState.self, from: data) {
            nowPlaying = state
        }
        if let speed = payload["speed"] as? Double {
            onSpeed?(speed)
        }
        if let key = payload["elevenKey"] as? String {
            let voiceID = payload["elevenVoiceID"] as? String ?? ""
            let enabled = payload["elevenEnabled"] as? Bool ?? false
            onElevenLabsConfig?(key, voiceID, enabled)
        }
    }
}

extension WatchConnectivityBridge: WCSessionDelegate {
    nonisolated func session(_ session: WCSession,
                             activationDidCompleteWith state: WCSessionActivationState,
                             error: Error?) {
        Task { @MainActor in self.isReachable = session.isReachable }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in self.handle(message) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        Task { @MainActor in self.handle(context) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.isReachable = session.isReachable }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
    #endif
}
#endif
