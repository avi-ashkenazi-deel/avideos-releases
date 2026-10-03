import Foundation

/// One RTMP message, before chunking / after reassembly.
struct RTMPMessage: Equatable, Sendable {
    enum TypeID: UInt8, Sendable {
        case setChunkSize = 1
        case abort = 2
        case acknowledgement = 3
        case userControl = 4
        case windowAckSize = 5
        case setPeerBandwidth = 6
        case audio = 8
        case video = 9
        case dataAMF0 = 18
        case commandAMF0 = 20
    }

    var chunkStreamID: UInt32
    /// Milliseconds. Absolute (not delta) on our side; the reader also
    /// returns absolute values after summing deltas.
    var timestamp: UInt32
    var typeID: UInt8
    var messageStreamID: UInt32
    var payload: Data

    init(chunkStreamID: UInt32, timestamp: UInt32 = 0, type: TypeID,
         messageStreamID: UInt32 = 0, payload: Data) {
        self.chunkStreamID = chunkStreamID
        self.timestamp = timestamp
        self.typeID = type.rawValue
        self.messageStreamID = messageStreamID
        self.payload = payload
    }

    init(chunkStreamID: UInt32, timestamp: UInt32, rawType: UInt8,
         messageStreamID: UInt32, payload: Data) {
        self.chunkStreamID = chunkStreamID
        self.timestamp = timestamp
        self.typeID = rawType
        self.messageStreamID = messageStreamID
        self.payload = payload
    }

    var type: TypeID? { TypeID(rawValue: typeID) }
}

/// Conventional chunk-stream ids. Any 2…65599 works; keeping control,
/// commands, audio and video apart is what every encoder does and what
/// servers' logs expect.
enum RTMPChunkStream {
    static let protocolControl: UInt32 = 2
    static let command: UInt32 = 3
    static let audio: UInt32 = 4
    static let video: UInt32 = 6
    static let data: UInt32 = 5
}

/// Splits outgoing messages into chunks. Every message's first chunk uses a
/// full (type 0) header with an ABSOLUTE timestamp and continuations use
/// type 3 — a few bytes more than delta compression, but there is no
/// per-stream header state to get wrong, and every server accepts it.
struct RTMPChunkWriter {
    /// Our outgoing chunk size. Starts at the protocol default; raised by
    /// sending SetChunkSize (see `setChunkSizeMessage`).
    var chunkSize: Int = 128

    func encode(_ message: RTMPMessage) -> Data {
        var out = Data()
        out.reserveCapacity(message.payload.count + 16 + message.payload.count / max(chunkSize, 1))

        let extended = message.timestamp >= 0xFFFFFF
        let headerTimestamp = extended ? 0xFFFFFF : message.timestamp

        // First chunk: fmt 0.
        Self.appendBasicHeader(fmt: 0, chunkStreamID: message.chunkStreamID, into: &out)
        out.appendBigEndian24(headerTimestamp)
        out.appendBigEndian24(UInt32(message.payload.count))
        out.append(message.typeID)
        out.appendLittleEndian(message.messageStreamID)   // the one little-endian field in RTMP
        if extended { out.appendBigEndian(message.timestamp) }

        var offset = message.payload.startIndex
        let end = message.payload.endIndex
        var first = true
        repeat {
            if !first {
                Self.appendBasicHeader(fmt: 3, chunkStreamID: message.chunkStreamID, into: &out)
                // Continuations repeat the extended timestamp (what FFmpeg
                // and librtmp both send, and what servers expect).
                if extended { out.appendBigEndian(message.timestamp) }
            }
            let take = min(chunkSize, end - offset)
            out.append(message.payload[offset..<(offset + take)])
            offset += take
            first = false
        } while offset < end
        return out
    }

    /// 1-, 2- or 3-byte basic header depending on the chunk stream id.
    static func appendBasicHeader(fmt: UInt8, chunkStreamID csid: UInt32, into out: inout Data) {
        let fmtBits = (fmt & 0x03) << 6
        switch csid {
        case 2...63:
            out.append(fmtBits | UInt8(csid))
        case 64...319:
            out.append(fmtBits | 0)
            out.append(UInt8(csid - 64))
        default:
            let value = csid - 64
            out.append(fmtBits | 1)
            out.append(UInt8(value & 0xFF))
            out.append(UInt8((value >> 8) & 0xFF))
        }
    }

    // MARK: - Protocol control messages

    static func setChunkSizeMessage(_ size: Int) -> RTMPMessage {
        var payload = Data()
        payload.appendBigEndian(UInt32(size) & 0x7FFF_FFFF)
        return RTMPMessage(chunkStreamID: RTMPChunkStream.protocolControl, type: .setChunkSize, payload: payload)
    }

    static func acknowledgementMessage(sequenceNumber: UInt32) -> RTMPMessage {
        var payload = Data()
        payload.appendBigEndian(sequenceNumber)
        return RTMPMessage(chunkStreamID: RTMPChunkStream.protocolControl, type: .acknowledgement, payload: payload)
    }

    static func windowAckSizeMessage(_ size: UInt32) -> RTMPMessage {
        var payload = Data()
        payload.appendBigEndian(size)
        return RTMPMessage(chunkStreamID: RTMPChunkStream.protocolControl, type: .windowAckSize, payload: payload)
    }

    /// User control "PingResponse" (event 7) echoing a server's PingRequest.
    static func pingResponseMessage(timestamp: UInt32) -> RTMPMessage {
        var payload = Data()
        payload.appendBigEndian(UInt16(7))
        payload.appendBigEndian(timestamp)
        return RTMPMessage(chunkStreamID: RTMPChunkStream.protocolControl, type: .userControl, payload: payload)
    }

    /// An AMF0 command (`connect`, `createStream`, `publish`…).
    static func commandMessage(name: String, transactionID: Double,
                               arguments: [AMF0Value],
                               messageStreamID: UInt32 = 0) -> RTMPMessage {
        let payload = AMF0.encode([.string(name), .number(transactionID)] + arguments)
        return RTMPMessage(chunkStreamID: RTMPChunkStream.command, type: .commandAMF0,
                           messageStreamID: messageStreamID, payload: payload)
    }
}

/// Reassembles incoming chunks into messages — the server side of the
/// conversation (connect `_result`, `onStatus`, chunk-size changes, pings).
/// Feed it bytes as they arrive; it buffers partial chunks.
struct RTMPChunkReader {
    enum ReadError: Error, Equatable {
        case continuationWithoutHeader(UInt32)
        case messageTooLarge(Int)
    }

    /// The SERVER's chunk size; updated by the caller when a SetChunkSize
    /// message arrives (`apply(_:)` does it).
    var chunkSize: Int = 128
    /// Total bytes consumed, for the acknowledgement window.
    private(set) var bytesReceived: UInt64 = 0

    private struct StreamState {
        var timestamp: UInt32 = 0
        var timestampDelta: UInt32 = 0
        var length: Int = 0
        var typeID: UInt8 = 0
        var messageStreamID: UInt32 = 0
        var hasExtendedTimestamp = false
        var partial = Data()
    }

    private var streams: [UInt32: StreamState] = [:]
    private var buffer = Data()

    /// Upper bound on one message — servers never send anything near this;
    /// a larger length means the stream is garbage.
    static let maxMessageSize = 16 * 1024 * 1024

    /// Appends bytes and returns every message completed by them.
    mutating func feed(_ bytes: Data) throws -> [RTMPMessage] {
        buffer.append(bytes)
        var messages: [RTMPMessage] = []
        while let chunk = try parseOneChunk() {
            let (message, consumed) = chunk
            buffer.removeFirst(consumed)
            bytesReceived += UInt64(consumed)
            if let message { messages.append(message) }
        }
        return messages
    }

    /// Keeps the reader's chunk size in step with the server's
    /// SetChunkSize. Call for every message `feed` returns.
    mutating func apply(_ message: RTMPMessage) {
        guard message.type == .setChunkSize, message.payload.count >= 4 else { return }
        var reader = ByteReader(message.payload)
        if let size = try? reader.readUInt32() {
            chunkSize = max(1, Int(size & 0x7FFF_FFFF))
        }
    }

    /// Parses one complete chunk from the front of the buffer. Returns nil
    /// when more bytes are needed; the inner optional is a completed message.
    private mutating func parseOneChunk() throws -> (RTMPMessage?, Int)? {
        var reader = ByteReader(buffer)
        do {
            let first = try reader.readUInt8()
            let fmt = first >> 6
            var csid = UInt32(first & 0x3F)
            if csid == 0 {
                csid = UInt32(try reader.readUInt8()) + 64
            } else if csid == 1 {
                let low = UInt32(try reader.readUInt8())
                let high = UInt32(try reader.readUInt8())
                csid = (high << 8 | low) + 64
            }

            var state = streams[csid] ?? StreamState()
            let startingNewMessage = state.partial.isEmpty

            switch fmt {
            case 0:
                let ts = try reader.readUInt24()
                state.length = Int(try reader.readUInt24())
                state.typeID = try reader.readUInt8()
                state.messageStreamID = try reader.readUInt32LittleEndian()
                state.hasExtendedTimestamp = ts == 0xFFFFFF
                let absolute = try state.hasExtendedTimestamp ? reader.readUInt32() : ts
                state.timestamp = absolute
                state.timestampDelta = 0
            case 1:
                let delta = try reader.readUInt24()
                state.length = Int(try reader.readUInt24())
                state.typeID = try reader.readUInt8()
                state.hasExtendedTimestamp = delta == 0xFFFFFF
                let value = try state.hasExtendedTimestamp ? reader.readUInt32() : delta
                state.timestampDelta = value
                state.timestamp &+= value
            case 2:
                let delta = try reader.readUInt24()
                state.hasExtendedTimestamp = delta == 0xFFFFFF
                let value = try state.hasExtendedTimestamp ? reader.readUInt32() : delta
                state.timestampDelta = value
                state.timestamp &+= value
            default:
                guard streams[csid] != nil else {
                    throw ReadError.continuationWithoutHeader(csid)
                }
                if state.hasExtendedTimestamp { _ = try reader.readUInt32() }
                // A type-3 chunk that STARTS a message reuses the last delta.
                if startingNewMessage, state.timestampDelta > 0 {
                    state.timestamp &+= state.timestampDelta
                }
            }

            guard state.length <= Self.maxMessageSize else {
                throw ReadError.messageTooLarge(state.length)
            }
            let need = min(chunkSize, state.length - state.partial.count)
            let body = try reader.readData(need)
            state.partial.append(body)

            var completed: RTMPMessage?
            if state.partial.count >= state.length {
                completed = RTMPMessage(chunkStreamID: csid,
                                        timestamp: state.timestamp,
                                        rawType: state.typeID,
                                        messageStreamID: state.messageStreamID,
                                        payload: state.partial)
                state.partial = Data()
            }
            streams[csid] = state
            return (completed, reader.offset)
        } catch AMF0.DecodeError.truncated {
            return nil   // wait for more bytes; nothing consumed
        }
    }
}
