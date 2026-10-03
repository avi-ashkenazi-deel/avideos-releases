import Foundation
import CoreMedia
import Network
import os

/// Publishes one destination over RTMP/RTMPS: handshake, `connect`,
/// `createStream`, `publish`, then FLV audio/video from the shared encoders.
///
/// Everything runs on one private serial queue. Encoders call in from their
/// own threads; state changes are reported on the main queue.
///
/// Resilience:
/// - **Backpressure**: if more than ~2 s of video is waiting to go out, video
///   is dropped until the next keyframe (audio keeps flowing — a frozen
///   picture is far less jarring than broken sound).
/// - **Reconnect**: a dropped connection retries with backoff (1, 2, 4… 30 s)
///   and resumes from a fresh keyframe with fresh sequence headers.
final class RTMPPublisher: @unchecked Sendable {
    enum State: Equatable, Sendable {
        case idle
        case connecting
        case live
        case reconnecting(attempt: Int, reason: String)
        case failed(String)
        case stopped

        var isActive: Bool {
            switch self {
            case .connecting, .live, .reconnecting: return true
            default: return false
            }
        }
    }

    struct Stats: Equatable, Sendable {
        var kilobitsPerSecond: Int = 0
        var queuedMilliseconds: Int = 0
        var droppedVideoFrames: Int = 0
        var reconnects: Int = 0
    }

    let url: StreamURL
    /// Main queue.
    var onStateChange: ((State) -> Void)?
    /// Main queue, ~1 Hz.
    var onStats: ((Stats) -> Void)?

    private let video: VideoStreamEncoder
    private let audio: AACStreamEncoder
    private let queue: DispatchQueue
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "rtmp")

    // Connection
    private var connection: NWConnection?
    private var writer = RTMPChunkWriter()
    private var reader = RTMPChunkReader()
    private var handshakeBuffer = Data()
    private var phase: Phase = .idle
    private var messageStreamID: UInt32 = 0
    private var serverWindowAckSize: UInt32 = 0
    private var lastAcknowledged: UInt64 = 0
    private var reconnectAttempt = 0
    private var stopRequested = false

    // Media
    private var videoSubscription: UUID?
    private var audioSubscription: UUID?
    private var sentAVCConfig: Data?
    private var waitingForKeyframe = true
    private var dropUntilKeyframe = false
    private var epoch: CMTime?
    private var lastVideoTimestamp: UInt32 = 0
    private var lastAudioTimestamp: UInt32 = 0

    // Stats
    private var bytesInFlight = 0
    private var bytesSentThisSecond = 0
    private var stats = Stats()
    private var statsTimer: DispatchSourceTimer?

    private static let maxReconnectAttempts = 30

    private enum Phase {
        case idle
        case handshake
        case connecting       // waiting for connect _result
        case creatingStream   // waiting for createStream _result
        case publishing       // waiting for onStatus Publish.Start
        case live
    }

    private enum Transaction {
        static let connect: Double = 1
        static let releaseStream: Double = 2
        static let fcPublish: Double = 3
        static let createStream: Double = 4
        static let publish: Double = 5
    }

    init(url: StreamURL, video: VideoStreamEncoder, audio: AACStreamEncoder) {
        self.url = url
        self.video = video
        self.audio = audio
        self.queue = DispatchQueue(label: "com.aviashkenazi.streamit.rtmp.\(url.host)", qos: .userInitiated)
    }

    // MARK: - Lifecycle

    func start() {
        queue.async { [self] in
            stopRequested = false
            reconnectAttempt = 0
            subscribeToEncoders()
            startStatsTimer()
            connect()
        }
    }

    /// Clean stop: unpublish politely, then close.
    func stop() {
        queue.async { [self] in
            stopRequested = true
            unsubscribeFromEncoders()
            statsTimer?.cancel()
            statsTimer = nil
            if phase == .live {
                send(RTMPMessage(chunkStreamID: RTMPChunkStream.video,
                                 timestamp: lastVideoTimestamp, type: .video,
                                 messageStreamID: messageStreamID,
                                 payload: FLVTags.avcEndOfSequence()))
                send(RTMPChunkWriter.commandMessage(name: "FCUnpublish", transactionID: 0,
                                                    arguments: [.null, .string(url.streamName)]))
                send(RTMPChunkWriter.commandMessage(name: "deleteStream", transactionID: 0,
                                                    arguments: [.null, .number(Double(messageStreamID))]))
            }
            // Give the goodbye a moment to flush.
            let closing = connection
            queue.asyncAfter(deadline: .now() + 0.5) { closing?.cancel() }
            connection = nil
            phase = .idle
            report(.stopped)
        }
    }

    // MARK: - Connection

    private func connect() {
        guard !stopRequested else { return }
        resetConnectionState()
        report(reconnectAttempt == 0
               ? .connecting
               : .reconnecting(attempt: reconnectAttempt, reason: "Reconnecting…"))

        let parameters: NWParameters = url.usesTLS ? .tls : .tcp
        if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.connectionTimeout = 10
        }
        guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: url.port)) else {
            fail("Invalid port \(url.port)")
            return
        }
        let connection = NWConnection(host: NWEndpoint.Host(url.host), port: port, using: parameters)
        self.connection = connection

        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection, connection === self.connection else { return }
            switch state {
            case .ready:
                self.beginHandshake()
                self.receive()
            case .failed(let error):
                self.connectionDropped("Connection failed: \(error.localizedDescription)")
            case .waiting(let error):
                self.connectionDropped("Network unavailable: \(error.localizedDescription)")
            case .cancelled:
                break
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func resetConnectionState() {
        writer = RTMPChunkWriter()
        reader = RTMPChunkReader()
        handshakeBuffer = Data()
        phase = .idle
        messageStreamID = 0
        serverWindowAckSize = 0
        lastAcknowledged = 0
        sentAVCConfig = nil
        waitingForKeyframe = true
        dropUntilKeyframe = false
        epoch = nil
        lastVideoTimestamp = 0
        lastAudioTimestamp = 0
        bytesInFlight = 0
    }

    private func connectionDropped(_ reason: String) {
        // Several callbacks (state, receive, send) can report the same
        // death; only the first one for the CURRENT connection counts.
        guard !stopRequested, connection != nil else { return }
        connection?.cancel()
        connection = nil
        phase = .idle
        reconnectAttempt += 1
        stats.reconnects += 1
        guard reconnectAttempt <= Self.maxReconnectAttempts else {
            fail(reason)
            return
        }
        log.warning("RTMP \(self.url.redactedDescription, privacy: .public) dropped: \(reason, privacy: .public)")
        report(.reconnecting(attempt: reconnectAttempt, reason: reason))
        let delay = min(pow(2, Double(reconnectAttempt - 1)), 30)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    private func fail(_ reason: String) {
        log.error("RTMP \(self.url.redactedDescription, privacy: .public) failed: \(reason, privacy: .public)")
        stopRequested = true
        unsubscribeFromEncoders()
        connection?.cancel()
        connection = nil
        phase = .idle
        report(.failed(reason))
    }

    // MARK: - Handshake (simple, unencrypted digest-less — what every ingest accepts)

    private static let handshakeSize = 1536

    private func beginHandshake() {
        phase = .handshake
        var c0c1 = Data([0x03])                       // RTMP version 3
        c0c1.append(contentsOf: [0, 0, 0, 0])         // time
        c0c1.append(contentsOf: [0, 0, 0, 0])         // zero
        var random = [UInt8](repeating: 0, count: Self.handshakeSize - 8)
        for index in random.indices { random[index] = UInt8.random(in: 0...255) }
        c0c1.append(contentsOf: random)
        sendRaw(c0c1)
    }

    /// S0 (1) + S1 (1536) + S2 (1536). C2 echoes S1.
    private func continueHandshake(with bytes: Data) {
        handshakeBuffer.append(bytes)
        let needed = 1 + Self.handshakeSize * 2
        guard handshakeBuffer.count >= needed else { return }
        let s1 = handshakeBuffer.subdata(in: 1..<(1 + Self.handshakeSize))
        let leftover = handshakeBuffer.count > needed ? handshakeBuffer.subdata(in: needed..<handshakeBuffer.count) : Data()
        handshakeBuffer = Data()
        sendRaw(s1)   // C2

        // Big chunks: fewer headers per video frame.
        send(RTMPChunkWriter.setChunkSizeMessage(4096))
        writer.chunkSize = 4096
        sendConnect()
        phase = .connecting
        if !leftover.isEmpty { handleIncoming(leftover) }
    }

    private func sendConnect() {
        let object: AMF0Value = .object([
            AMF0Pair("app", .string(url.app)),
            AMF0Pair("type", .string("nonprivate")),
            AMF0Pair("flashVer", .string("FMLE/3.0 (compatible; streamit)")),
            AMF0Pair("tcUrl", .string(url.tcURL)),
        ])
        send(RTMPChunkWriter.commandMessage(name: "connect", transactionID: Transaction.connect,
                                            arguments: [object]))
    }

    // MARK: - Receiving

    private func receive() {
        guard let current = connection else { return }
        current.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self, current === self.connection else { return }
            if let data, !data.isEmpty { self.handleIncoming(data) }
            if let error {
                self.connectionDropped("Receive error: \(error.localizedDescription)")
                return
            }
            if isComplete {
                self.connectionDropped("Server closed the connection")
                return
            }
            self.receive()
        }
    }

    private func handleIncoming(_ data: Data) {
        if phase == .handshake {
            continueHandshake(with: data)
            return
        }
        do {
            for message in try reader.feed(data) {
                reader.apply(message)
                handle(message)
            }
            acknowledgeIfNeeded()
        } catch {
            connectionDropped("Malformed data from server")
        }
    }

    private func acknowledgeIfNeeded() {
        guard serverWindowAckSize > 0,
              reader.bytesReceived - lastAcknowledged >= UInt64(serverWindowAckSize) else { return }
        lastAcknowledged = reader.bytesReceived
        send(RTMPChunkWriter.acknowledgementMessage(sequenceNumber: UInt32(truncatingIfNeeded: reader.bytesReceived)))
    }

    private func handle(_ message: RTMPMessage) {
        switch message.type {
        case .windowAckSize:
            var bytes = ByteReader(message.payload)
            serverWindowAckSize = (try? bytes.readUInt32()) ?? 0
        case .setPeerBandwidth:
            // Mirror it back as our acknowledgement window, as encoders do.
            var bytes = ByteReader(message.payload)
            if let size = try? bytes.readUInt32() {
                send(RTMPChunkWriter.windowAckSizeMessage(size))
            }
        case .userControl:
            var bytes = ByteReader(message.payload)
            if let event = try? bytes.readUInt16(), event == 6,
               let timestamp = try? bytes.readUInt32() {
                send(RTMPChunkWriter.pingResponseMessage(timestamp: timestamp))
            }
        case .commandAMF0:
            handleCommand(message.payload)
        default:
            break
        }
    }

    private func handleCommand(_ payload: Data) {
        guard let values = try? AMF0.decodeAll(payload),
              let name = values.first?.string else { return }
        let transaction = values.count > 1 ? (values[1].number ?? 0) : 0

        switch name {
        case "_result":
            if transaction == Transaction.connect, phase == .connecting {
                send(RTMPChunkWriter.commandMessage(name: "releaseStream", transactionID: Transaction.releaseStream,
                                                    arguments: [.null, .string(url.streamName)]))
                send(RTMPChunkWriter.commandMessage(name: "FCPublish", transactionID: Transaction.fcPublish,
                                                    arguments: [.null, .string(url.streamName)]))
                send(RTMPChunkWriter.commandMessage(name: "createStream", transactionID: Transaction.createStream,
                                                    arguments: [.null]))
                phase = .creatingStream
            } else if transaction == Transaction.createStream, phase == .creatingStream {
                messageStreamID = UInt32(values.count > 3 ? (values[3].number ?? 1) : 1)
                var publish = RTMPChunkWriter.commandMessage(
                    name: "publish", transactionID: Transaction.publish,
                    arguments: [.null, .string(url.streamName), .string("live")],
                    messageStreamID: messageStreamID)
                publish.chunkStreamID = RTMPChunkStream.data
                send(publish)
                phase = .publishing
                // A few ingests never send NetStream.Publish.Start; after a
                // quiet 3 s, start sending anyway (they're listening).
                let pending = connection
                queue.asyncAfter(deadline: .now() + 3) { [weak self] in
                    guard let self, self.connection === pending, self.phase == .publishing else { return }
                    self.goLive()
                }
            }
        case "_error":
            // releaseStream / FCPublish are courtesy calls some servers don't
            // implement; an _error for those is noise, not a refusal.
            guard transaction != Transaction.releaseStream,
                  transaction != Transaction.fcPublish else { return }
            let description = values.count > 3 ? (values[3]["description"]?.string ?? "") : ""
            fail(description.isEmpty ? "The server refused the stream." : description)
        case "onStatus":
            let info = values.count > 3 ? values[3] : .null
            let code = info["code"]?.string ?? ""
            let description = info["description"]?.string ?? code
            if code == "NetStream.Publish.Start" {
                goLive()
            } else if code.hasSuffix(".BadName") || code.hasSuffix(".Failed")
                        || code.hasSuffix(".Rejected") || code.hasSuffix(".Unauthorized") {
                fail(Self.friendly(code: code, description: description))
            }
        default:
            break   // onBWDone, onFCPublish, … — informational
        }
    }

    static func friendly(code: String, description: String) -> String {
        if code.hasSuffix(".BadName") {
            return "Stream key rejected. Check the key, and that the live event is ready on the platform."
        }
        return description.isEmpty ? code : description
    }

    // MARK: - Going live

    private func goLive() {
        guard phase == .publishing else { return }
        phase = .live
        reconnectAttempt = 0
        let settings = video.settings
        let metadata = RTMPMessage(chunkStreamID: RTMPChunkStream.data, timestamp: 0, type: .dataAMF0,
                                   messageStreamID: messageStreamID,
                                   payload: FLVTags.metadata(width: settings.width,
                                                             height: settings.height,
                                                             frameRate: Double(settings.framesPerSecond),
                                                             videoKbps: settings.bitsPerSecond / 1000,
                                                             audioKbps: audio.bitsPerSecond / 1000))
        send(metadata)
        send(RTMPMessage(chunkStreamID: RTMPChunkStream.audio, timestamp: 0, type: .audio,
                         messageStreamID: messageStreamID,
                         payload: FLVTags.aacSequenceHeader(audioSpecificConfig: audio.audioSpecificConfig)))
        waitingForKeyframe = true
        video.requestKeyframe()
        report(.live)
    }

    // MARK: - Media in (encoder threads → our queue)

    private func subscribeToEncoders() {
        if videoSubscription == nil {
            videoSubscription = video.frames.add { [weak self] frame in
                self?.queue.async { self?.sendVideo(frame) }
            }
        }
        if audioSubscription == nil {
            audioSubscription = audio.packets.add { [weak self] packet in
                self?.queue.async { self?.sendAudio(packet) }
            }
        }
    }

    private func unsubscribeFromEncoders() {
        if let videoSubscription { video.frames.remove(videoSubscription) }
        if let audioSubscription { audio.packets.remove(audioSubscription) }
        videoSubscription = nil
        audioSubscription = nil
    }

    private func sendVideo(_ frame: VideoStreamEncoder.EncodedFrame) {
        guard phase == .live else { return }

        if waitingForKeyframe || dropUntilKeyframe {
            guard frame.isKeyframe else {
                if dropUntilKeyframe { stats.droppedVideoFrames += 1 }
                return
            }
            waitingForKeyframe = false
            dropUntilKeyframe = false
        }

        // Congested: shed video until the backlog clears, resuming on a
        // keyframe so the picture never smears.
        let backlogLimit = video.settings.bitsPerSecond / 8 * 2
        if bytesInFlight > backlogLimit {
            dropUntilKeyframe = true
            video.requestKeyframe()
            stats.droppedVideoFrames += 1
            return
        }

        // (Re)send the decoder config whenever it's new to this connection.
        if let config = video.decoderConfiguration, config != sentAVCConfig {
            sentAVCConfig = config
            send(RTMPMessage(chunkStreamID: RTMPChunkStream.video,
                             timestamp: lastVideoTimestamp, type: .video,
                             messageStreamID: messageStreamID,
                             payload: FLVTags.avcSequenceHeader(avcC: config)))
        }
        guard sentAVCConfig != nil else { return }

        if epoch == nil { epoch = frame.presentationTime }
        let timestamp = streamTimestamp(frame.presentationTime, after: &lastVideoTimestamp)
        send(RTMPMessage(chunkStreamID: RTMPChunkStream.video, timestamp: timestamp, type: .video,
                         messageStreamID: messageStreamID,
                         payload: FLVTags.avcFrame(avcc: frame.avcc, isKeyframe: frame.isKeyframe)))
    }

    private func sendAudio(_ packet: AACStreamEncoder.Packet) {
        // Audio starts with the first keyframe so both share one zero.
        guard phase == .live, let epoch, packet.presentationTime >= epoch else { return }
        let timestamp = streamTimestamp(packet.presentationTime, after: &lastAudioTimestamp)
        send(RTMPMessage(chunkStreamID: RTMPChunkStream.audio, timestamp: timestamp, type: .audio,
                         messageStreamID: messageStreamID,
                         payload: FLVTags.aacFrame(packet.data)))
    }

    /// Milliseconds since this connection's epoch, never going backwards.
    private func streamTimestamp(_ time: CMTime, after last: inout UInt32) -> UInt32 {
        guard let epoch else { return last }
        let ms = max(0, (time - epoch).seconds * 1000)
        let value = max(UInt32(clamping: Int(ms.rounded())), last)
        last = value
        return value
    }

    // MARK: - Sending

    private func send(_ message: RTMPMessage) {
        sendRaw(writer.encode(message))
    }

    private func sendRaw(_ data: Data) {
        guard let connection else { return }
        bytesInFlight += data.count
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            // A completion from a connection we've since replaced must not
            // touch the new one's accounting or tear it down.
            guard let self, connection === self.connection else { return }
            self.bytesInFlight -= data.count
            self.bytesSentThisSecond += data.count
            if let error {
                self.connectionDropped("Send error: \(error.localizedDescription)")
            }
        })
    }

    // MARK: - Reporting

    private func startStatsTimer() {
        statsTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.stats.kilobitsPerSecond = self.bytesSentThisSecond * 8 / 1000
            self.bytesSentThisSecond = 0
            let bytesPerSecond = max(self.video.settings.bitsPerSecond / 8, 1)
            self.stats.queuedMilliseconds = self.bytesInFlight * 1000 / bytesPerSecond
            let snapshot = self.stats
            DispatchQueue.main.async { self.onStats?(snapshot) }
        }
        timer.resume()
        statsTimer = timer
    }

    private func report(_ state: State) {
        DispatchQueue.main.async { [weak self] in self?.onStateChange?(state) }
    }
}
