import XCTest
@testable import Streamit

/// The streaming protocol core: AMF0, RTMP chunking both ways, FLV tag
/// bodies and ingest-URL parsing. Pure byte work — no network, no encoder.
/// Expected bytes are worked from the RTMP 1.0 / AMF0 / FLV 10.1 specs.
final class RTMPTests: XCTestCase {

    // MARK: - AMF0

    func testAMF0ScalarBytes() {
        XCTAssertEqual(AMF0.encode([.string("connect")]),
                       Data([0x02, 0x00, 0x07]) + Data("connect".utf8))
        XCTAssertEqual(AMF0.encode([.number(1)]),
                       Data([0x00, 0x3F, 0xF0, 0, 0, 0, 0, 0, 0]))
        XCTAssertEqual(AMF0.encode([.bool(true)]), Data([0x01, 0x01]))
        XCTAssertEqual(AMF0.encode([.null]), Data([0x05]))
    }

    func testAMF0ObjectBytes() {
        let encoded = AMF0.encode([.object([AMF0Pair("a", .bool(true))])])
        XCTAssertEqual(encoded, Data([0x03, 0x00, 0x01, 0x61, 0x01, 0x01, 0x00, 0x00, 0x09]))
    }

    func testAMF0ConnectCommandRoundTrip() throws {
        let values: [AMF0Value] = [
            .string("connect"),
            .number(1),
            .object([
                AMF0Pair("app", .string("live2")),
                AMF0Pair("type", .string("nonprivate")),
                AMF0Pair("flashVer", .string("FMLE/3.0 (compatible; streamit)")),
                AMF0Pair("tcUrl", .string("rtmp://a.rtmp.youtube.com/live2")),
            ]),
            .null,
            .ecmaArray([AMF0Pair("width", .number(1920)), AMF0Pair("stereo", .bool(true))]),
            .strictArray([.number(1), .string("x")]),
        ]
        let decoded = try AMF0.decodeAll(AMF0.encode(values))
        XCTAssertEqual(decoded, values)
        XCTAssertEqual(decoded[2]["app"]?.string, "live2")
    }

    func testAMF0TruncatedInputThrows() {
        let full = AMF0.encode([.string("onStatus")])
        XCTAssertThrowsError(try AMF0.decodeAll(full.prefix(full.count - 2)))
    }

    // MARK: - Chunk writer

    func testChunkWriterSplitsWithType3Continuations() {
        let payload = Data((0..<300).map { UInt8($0 & 0xFF) })
        let message = RTMPMessage(chunkStreamID: 3, timestamp: 0, type: .commandAMF0,
                                  messageStreamID: 0, payload: payload)
        let bytes = RTMPChunkWriter(chunkSize: 128).encode(message)

        // 12-byte fmt0 header + 128, then (1 + 128), then (1 + 44).
        XCTAssertEqual(bytes.count, 12 + 128 + 1 + 128 + 1 + 44)
        XCTAssertEqual(Array(bytes.prefix(12)),
                       [0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x2C, 0x14, 0x00, 0x00, 0x00, 0x00])
        XCTAssertEqual(bytes[12 + 128], 0xC3)
        XCTAssertEqual(bytes[12 + 128 + 1 + 128], 0xC3)
    }

    func testMessageStreamIDIsLittleEndian() {
        let message = RTMPMessage(chunkStreamID: 6, timestamp: 0, type: .video,
                                  messageStreamID: 1, payload: Data([0xAA]))
        let bytes = Array(RTMPChunkWriter(chunkSize: 128).encode(message))
        XCTAssertEqual(Array(bytes[8..<12]), [0x01, 0x00, 0x00, 0x00])
    }

    func testExtendedTimestampOnEveryChunk() {
        let ts: UInt32 = 0x0100_0000
        let message = RTMPMessage(chunkStreamID: 4, timestamp: ts, type: .audio,
                                  messageStreamID: 1, payload: Data(repeating: 0x11, count: 200))
        let bytes = Array(RTMPChunkWriter(chunkSize: 128).encode(message))
        XCTAssertEqual(Array(bytes[1..<4]), [0xFF, 0xFF, 0xFF])
        XCTAssertEqual(Array(bytes[12..<16]), [0x01, 0x00, 0x00, 0x00])
        // Continuation: 1-byte header then the extended timestamp again.
        let continuation = 16 + 128
        XCTAssertEqual(bytes[continuation], 0xC4)
        XCTAssertEqual(Array(bytes[(continuation + 1)..<(continuation + 5)]), [0x01, 0x00, 0x00, 0x00])
    }

    func testBasicHeaderWidths() {
        var two = Data()
        RTMPChunkWriter.appendBasicHeader(fmt: 0, chunkStreamID: 64, into: &two)
        XCTAssertEqual(Array(two), [0x00, 0x00])
        var three = Data()
        RTMPChunkWriter.appendBasicHeader(fmt: 3, chunkStreamID: 320, into: &three)
        XCTAssertEqual(Array(three), [0xC1, 0x00, 0x01])
    }

    // MARK: - Chunk reader

    func testReaderReassemblesWriterOutputByteByByte() throws {
        let writer = RTMPChunkWriter(chunkSize: 128)
        let messages = [
            RTMPMessage(chunkStreamID: 3, timestamp: 0, type: .commandAMF0,
                        payload: AMF0.encode([.string("_result"), .number(1), .null, .null])),
            RTMPMessage(chunkStreamID: 6, timestamp: 40, type: .video, messageStreamID: 1,
                        payload: Data(repeating: 0x42, count: 1000)),
            RTMPMessage(chunkStreamID: 4, timestamp: 0x0123_4567, type: .audio, messageStreamID: 1,
                        payload: Data(repeating: 0x07, count: 300)),
        ]
        var stream = Data()
        for message in messages { stream.append(writer.encode(message)) }

        var reader = RTMPChunkReader()
        var received: [RTMPMessage] = []
        for byte in stream {
            received.append(contentsOf: try reader.feed(Data([byte])))
        }
        XCTAssertEqual(received, messages)
        XCTAssertEqual(reader.bytesReceived, UInt64(stream.count))
    }

    func testReaderDeltaHeaders() throws {
        var bytes = Data()
        // fmt0, csid 4: ts 100, length 2, type 8, msid 1.
        bytes.append(contentsOf: [0x04, 0x00, 0x00, 0x64, 0x00, 0x00, 0x02, 0x08, 0x01, 0x00, 0x00, 0x00, 0xAA, 0xBB])
        // fmt2: delta 20, same length/type.
        bytes.append(contentsOf: [0x84, 0x00, 0x00, 0x14, 0xCC, 0xDD])
        // fmt3 starting a new message: reuses the last delta.
        bytes.append(contentsOf: [0xC4, 0xEE, 0xFF])

        var reader = RTMPChunkReader()
        let messages = try reader.feed(bytes)
        XCTAssertEqual(messages.map(\.timestamp), [100, 120, 140])
        XCTAssertEqual(messages.map(\.payload), [Data([0xAA, 0xBB]), Data([0xCC, 0xDD]), Data([0xEE, 0xFF])])
        XCTAssertEqual(messages.map(\.messageStreamID), [1, 1, 1])
    }

    func testReaderFollowsServerChunkSize() throws {
        let big = RTMPMessage(chunkStreamID: 3, timestamp: 0, type: .commandAMF0,
                              payload: Data(repeating: 0x55, count: 5000))
        let setSize = RTMPChunkWriter.setChunkSizeMessage(4096)
        var stream = RTMPChunkWriter(chunkSize: 128).encode(setSize)
        stream.append(RTMPChunkWriter(chunkSize: 4096).encode(big))

        var reader = RTMPChunkReader()
        var received: [RTMPMessage] = []
        for message in try reader.feed(stream.prefix(16)) {
            reader.apply(message)
            received.append(message)
        }
        for message in try reader.feed(stream.dropFirst(16)) {
            reader.apply(message)
            received.append(message)
        }
        XCTAssertEqual(reader.chunkSize, 4096)
        XCTAssertEqual(received.last, big)
    }

    func testContinuationWithoutHeaderIsAnError() {
        var reader = RTMPChunkReader()
        XCTAssertThrowsError(try reader.feed(Data([0xC7, 0x00])))
    }

    // MARK: - FLV tag bodies

    func testAudioSpecificConfig() {
        XCTAssertEqual(FLVTags.audioSpecificConfig(sampleRate: 48000, channels: 2), Data([0x11, 0x90]))
        XCTAssertEqual(FLVTags.audioSpecificConfig(sampleRate: 44100, channels: 2), Data([0x12, 0x10]))
    }

    func testAACTags() {
        XCTAssertEqual(FLVTags.aacSequenceHeader(audioSpecificConfig: Data([0x11, 0x90])),
                       Data([0xAF, 0x00, 0x11, 0x90]))
        XCTAssertEqual(FLVTags.aacFrame(Data([0x21, 0x22])), Data([0xAF, 0x01, 0x21, 0x22]))
    }

    func testAVCTags() {
        let avcC = Data([0x01, 0x64, 0x00, 0x28, 0xFF, 0xE1])
        XCTAssertEqual(FLVTags.avcSequenceHeader(avcC: avcC), Data([0x17, 0x00, 0, 0, 0]) + avcC)
        let nalu = Data([0x00, 0x00, 0x00, 0x02, 0x65, 0x88])
        XCTAssertEqual(FLVTags.avcFrame(avcc: nalu, isKeyframe: true), Data([0x17, 0x01, 0, 0, 0]) + nalu)
        XCTAssertEqual(FLVTags.avcFrame(avcc: nalu, isKeyframe: false).prefix(2), Data([0x27, 0x01]))
    }

    func testMetadataDecodes() throws {
        let values = try AMF0.decodeAll(FLVTags.metadata(width: 1080, height: 1920, frameRate: 30,
                                                         videoKbps: 6000, audioKbps: 160))
        XCTAssertEqual(values.first?.string, "@setDataFrame")
        XCTAssertEqual(values[1].string, "onMetaData")
        XCTAssertEqual(values[2]["height"]?.number, 1920)
        XCTAssertEqual(values[2]["videocodecid"]?.number, 7)
    }

    // MARK: - Ingest URLs

    func testYouTubeServerPlusKey() throws {
        let url = try StreamURL.parse(server: "rtmp://a.rtmp.youtube.com/live2", key: "abcd-efgh")
        XCTAssertEqual(url.host, "a.rtmp.youtube.com")
        XCTAssertEqual(url.port, 1935)
        XCTAssertFalse(url.usesTLS)
        XCTAssertEqual(url.app, "live2")
        XCTAssertEqual(url.tcURL, "rtmp://a.rtmp.youtube.com/live2")
        XCTAssertEqual(url.streamName, "abcd-efgh")
    }

    func testRTMPSWithPortAndQueryKey() throws {
        let url = try StreamURL.parse(server: "rtmps://edgetee-upload.example.com:443/rtmp/",
                                      key: "1789?s_bl=1&s_sw=0&a=XYZ")
        XCTAssertTrue(url.usesTLS)
        XCTAssertEqual(url.port, 443)
        XCTAssertEqual(url.app, "rtmp")
        XCTAssertEqual(url.tcURL, "rtmps://edgetee-upload.example.com/rtmp")
        XCTAssertEqual(url.streamName, "1789?s_bl=1&s_sw=0&a=XYZ")
    }

    func testNonDefaultPortStaysInTcURL() throws {
        let url = try StreamURL.parse(server: "rtmp://ingest.example.com:1940/app", key: "k")
        XCTAssertEqual(url.port, 1940)
        XCTAssertEqual(url.tcURL, "rtmp://ingest.example.com:1940/app")
    }

    func testOnePastedURLSplitsTheKeyOff() throws {
        let url = try StreamURL.parse(server: "rtmp://live.twitch.tv/app/live_123_abc", key: "")
        XCTAssertEqual(url.app, "app")
        XCTAssertEqual(url.streamName, "live_123_abc")
    }

    func testBadURLs() {
        XCTAssertThrowsError(try StreamURL.parse(server: "https://youtube.com/live2", key: "k"))
        XCTAssertThrowsError(try StreamURL.parse(server: "rtmp://host.example.com", key: ""))
        XCTAssertThrowsError(try StreamURL.parse(server: "rtmp:///live2", key: "k"))
    }

    func testRedactionHidesMostOfTheKey() throws {
        let url = try StreamURL.parse(server: "rtmp://a.rtmp.youtube.com/live2", key: "secret-key-1234")
        XCTAssertFalse(url.redactedDescription.contains("secret"))
        XCTAssertTrue(url.redactedDescription.hasSuffix("1234"))
    }
}
