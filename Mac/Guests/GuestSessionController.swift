import Foundation
import Observation
import AVFoundation
import CoreMedia
import Metal
import LiveKit
import os

/// Owns the LiveKit `Room` for a show: connects as host, routes each guest's
/// video into a `GuestSource` (registered with the SourceRegistry) and audio
/// into a mixer ring, publishes the mix-minus bus back to guests via the
/// "AVideos Guest Send" virtual device, and multiplexes the data channel
/// (podcast record control, upload progress, teleprompter remote).
///
/// All LiveKit types stay inside Mac/Guests/ — the rest of the app sees
/// GuestParticipant/GuestDescriptor and plain closures.
@MainActor
@Observable
final class GuestSessionController {
    enum SessionState: Equatable {
        case disconnected
        case connecting
        case connected(roomName: String)
        case failed(String)
    }

    private(set) var state: SessionState = .disconnected
    private(set) var guests: [GuestParticipant] = []
    private(set) var inviteURL: URL?

    /// Injected wiring (set by StudioController before connect).
    var registerSource: ((FrameSource) -> Void)?
    var unregisterSource: ((SourceKey) -> Void)?
    /// Returns the mixer ring for a guest strip (AudioEngineController.attachGuest).
    var attachGuestAudio: ((String) -> RingBuffer?)?
    var detachGuestAudio: ((String) -> Void)?
    /// Non-prompter/podcast consumers of data messages (podcast controller,
    /// teleprompter controller) — called on the main actor with decoded JSON.
    var onDataMessage: (([String: Any]) -> Void)?
    /// Guests changed (join/leave/name) — recompile the render plan.
    var onGuestsChanged: (() -> Void)?

    private var room: Room?
    private var videoReceivers: [String: GuestVideoReceiver] = [:]
    private var audioReceivers: [String: GuestAudioReceiver] = [:]
    private let metalDevice: MTLDevice
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "guests")

    /// The mix-minus capture device UID (the loopback driver's second device).
    static let guestSendDeviceUID = "com.aviashkenazi.avideos.gsend"

    init(metalDevice: MTLDevice) {
        self.metalDevice = metalDevice
    }

    var guestDescriptors: [GuestDescriptor] {
        guests.map(\.descriptor)
    }

    // MARK: - Connection

    func connect(livekitURL: String, token: String, roomName: String, inviteURL: URL?) async {
        guard state == .disconnected || state.isFailed else { return }
        state = .connecting
        self.inviteURL = inviteURL

        let room = Room()
        room.add(delegate: self)
        self.room = room

        do {
            // Capture from the Guest Send loopback device so guests hear the
            // host + music + pads but never themselves (mix-minus by
            // construction). Voice processing off: the feed is already clean
            // and guests' browsers do their own AEC.
            // `inputDevice` is a settable property, and macOS-only — on other
            // platforms the setter is a no-op, which is why it can't throw.
            if let device = AudioManager.shared.inputDevices.first(where: { $0.deviceId == Self.guestSendDeviceUID }) {
                AudioManager.shared.inputDevice = device
            } else {
                log.warning("Guest Send device not found; guests will hear the raw default mic")
            }

            try await room.connect(url: livekitURL, token: token)
            try await room.localParticipant.setMicrophone(enabled: true)
            state = .connected(roomName: roomName)
            log.info("Connected to room \(roomName)")
        } catch {
            state = .failed(error.localizedDescription)
            self.room = nil
            log.error("Room connect failed: \(error.localizedDescription)")
        }
    }

    func disconnect() async {
        if let room {
            await room.disconnect()
        }
        room = nil
        for guest in guests {
            teardownGuest(identity: guest.identity)
        }
        guests.removeAll()
        state = .disconnected
        onGuestsChanged?()
    }

    // MARK: - Data channel

    /// Sends a JSON message to every participant (reliable).
    func sendData(_ message: [String: Any]) {
        guard let room,
              let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        Task {
            try? await room.localParticipant.publish(data: data, options: DataPublishOptions(reliable: true))
        }
    }

    private func handleIncomingData(_ data: Data, from identity: String?) {
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        Task { @MainActor in
            // Track guest recording/upload health inline; forward everything.
            if let type = json["type"] as? String {
                switch type {
                case "upload-progress":
                    if let pid = json["participantId"] as? String,
                       let guest = self.guests.first(where: { $0.identity == pid }) {
                        guest.uploadProgress = (json["pct"] as? Double).map { $0 / 100.0 }
                        guest.uploadQueuedChunks = json["queuedChunks"] as? Int ?? 0
                        guest.isRecordingLocally = json["recording"] as? Bool ?? false
                    }
                case "record-error":
                    if let pid = json["participantId"] as? String,
                       let guest = self.guests.first(where: { $0.identity == pid }) {
                        guest.lastError = json["message"] as? String
                    }
                default:
                    break
                }
            }
            self.onDataMessage?(json)
        }
    }

    // MARK: - Guest lifecycle

    private func setupGuest(participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue ?? UUID().uuidString
        guard !guests.contains(where: { $0.identity == identity }) else { return }
        let name = participant.name?.isEmpty == false ? participant.name! : identity
        // The prompter remote joins the room but publishes nothing and should
        // not appear as a guest tile.
        if name == "Prompter" { return }
        guests.append(GuestParticipant(identity: identity, displayName: name))
        onGuestsChanged?()
    }

    private func teardownGuest(identity: String) {
        videoReceivers.removeValue(forKey: identity)
        audioReceivers.removeValue(forKey: identity)
        unregisterSource?(.guest(identity: identity))
        detachGuestAudio?(identity)
    }

    private func attachVideo(track: RemoteVideoTrack, identity: String) {
        let source = GuestSource(key: .guest(identity: identity), metalDevice: metalDevice)
        registerSource?(source)
        let receiver = GuestVideoReceiver(identity: identity, source: source)
        videoReceivers[identity] = receiver
        track.add(videoRenderer: receiver)
        guests.first(where: { $0.identity == identity })?.hasVideo = true
        onGuestsChanged?()
    }

    private func attachAudio(track: RemoteAudioTrack, identity: String) {
        guard let ring = attachGuestAudio?(identity) else { return }
        let receiver = GuestAudioReceiver(identity: identity, ring: ring)
        audioReceivers[identity] = receiver
        track.add(audioRenderer: receiver)
        // Mute SDK playback — the renderer keeps receiving buffers, but audio
        // reaches speakers only through our mixer strip. `volume` is playback
        // gain on the remote track, so this does not affect what `add(audio-
        // Renderer:)` delivers.
        track.volume = 0
        guests.first(where: { $0.identity == identity })?.hasAudio = true
        onGuestsChanged?()
    }
}

// MARK: - RoomDelegate

extension GuestSessionController: RoomDelegate {
    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor in
            self.setupGuest(participant: participant)
        }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor in
            let identity = participant.identity?.stringValue ?? ""
            self.teardownGuest(identity: identity)
            self.guests.removeAll { $0.identity == identity }
            self.onGuestsChanged?()
        }
    }

    nonisolated func room(_ room: Room,
                          participant: RemoteParticipant,
                          didSubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            let identity = participant.identity?.stringValue ?? ""
            self.setupGuest(participant: participant)
            switch publication.track {
            case let video as RemoteVideoTrack:
                self.attachVideo(track: video, identity: identity)
            case let audio as RemoteAudioTrack:
                self.attachAudio(track: audio, identity: identity)
            default:
                break
            }
        }
    }

    nonisolated func room(_ room: Room,
                          participant: RemoteParticipant,
                          didUnsubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            let identity = participant.identity?.stringValue ?? ""
            // Key off publication.kind, not publication.track — the track
            // reference may already be cleared by the time the unsubscribe
            // callback fires, which would leak receivers/sources.
            if publication.kind == .video {
                self.videoReceivers.removeValue(forKey: identity)
                self.unregisterSource?(.guest(identity: identity))
                self.guests.first(where: { $0.identity == identity })?.hasVideo = false
            }
            if publication.kind == .audio {
                self.audioReceivers.removeValue(forKey: identity)
                self.detachGuestAudio?(identity)
                self.guests.first(where: { $0.identity == identity })?.hasAudio = false
            }
            self.onGuestsChanged?()
        }
    }

    /// `encryptionType` is ignored: the room is not E2EE, and a packet that
    /// arrived at all was already decrypted by the SDK if it needed to be.
    nonisolated func room(_ room: Room,
                          participant: RemoteParticipant?,
                          didReceiveData data: Data,
                          forTopic topic: String,
                          encryptionType: EncryptionType) {
        let identity = participant?.identity?.stringValue
        Task { @MainActor in
            self.handleIncomingData(data, from: identity)
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor in
            if let error {
                self.state = .failed(error.localizedDescription)
            } else {
                self.state = .disconnected
            }
        }
    }
}

private extension GuestSessionController.SessionState {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
