import Foundation

/// RTMP audio/video message payloads are FLV tag BODIES (no FLV tag header,
/// no previous-tag-size). These builders produce exactly those bytes for
/// H.264 and AAC — the pair every platform in the destination list takes.
enum FLVTags {

    // MARK: - Video (codec 7 = AVC)

    /// Byte 0 = frame type (1 key, 2 inter) << 4 | codec id 7.
    static let avcKeyframe: UInt8 = 0x17
    static let avcInterframe: UInt8 = 0x27

    /// AVCPacketType 0: the decoder configuration record. Must precede the
    /// first frame and be resent after every reconnect.
    static func avcSequenceHeader(avcC: Data) -> Data {
        var out = Data([avcKeyframe, 0x00, 0x00, 0x00, 0x00])
        out.append(avcC)
        return out
    }

    /// AVCPacketType 1: one access unit in AVCC form (4-byte big-endian NAL
    /// lengths) — VideoToolbox's native output, so no rewriting needed.
    /// `compositionTimeMs` is PTS − DTS; 0 because the encoder runs with
    /// frame reordering off.
    static func avcFrame(avcc: Data, isKeyframe: Bool, compositionTimeMs: Int32 = 0) -> Data {
        var out = Data()
        out.reserveCapacity(avcc.count + 5)
        out.append(isKeyframe ? avcKeyframe : avcInterframe)
        out.append(0x01)
        // Signed 24-bit composition time offset.
        let cts = UInt32(bitPattern: compositionTimeMs) & 0x00FF_FFFF
        out.appendBigEndian24(cts)
        out.append(avcc)
        return out
    }

    /// AVCPacketType 2: end of sequence, sent on a clean stop.
    static func avcEndOfSequence() -> Data {
        Data([avcKeyframe, 0x02, 0x00, 0x00, 0x00])
    }

    // MARK: - Audio (format 10 = AAC)

    /// Byte 0 for AAC: format 10 << 4 | rate index 3 (always "44 kHz" for
    /// AAC — the real rate is in the AudioSpecificConfig) << 2 | 16-bit << 1
    /// | stereo. = 0xAF.
    static let aacHeaderByte: UInt8 = 0xAF

    /// AACPacketType 0: the AudioSpecificConfig.
    static func aacSequenceHeader(audioSpecificConfig: Data) -> Data {
        var out = Data([aacHeaderByte, 0x00])
        out.append(audioSpecificConfig)
        return out
    }

    /// AACPacketType 1: one raw AAC frame (no ADTS header).
    static func aacFrame(_ raw: Data) -> Data {
        var out = Data([aacHeaderByte, 0x01])
        out.append(raw)
        return out
    }

    /// AudioSpecificConfig for AAC-LC (object type 2):
    /// 5 bits object type, 4 bits sampling-frequency index, 4 bits channel
    /// configuration, 3 bits of zero. 48 kHz stereo → 0x11 0x90.
    static func audioSpecificConfig(sampleRate: Double, channels: Int) -> Data {
        let rates: [Double] = [96000, 88200, 64000, 48000, 44100, 32000,
                               24000, 22050, 16000, 12000, 11025, 8000, 7350]
        let index = UInt16(rates.firstIndex(of: sampleRate) ?? 3)
        let objectType: UInt16 = 2
        let bits = objectType << 11 | index << 7 | UInt16(channels & 0x0F) << 3
        return Data([UInt8(bits >> 8), UInt8(bits & 0xFF)])
    }

    // MARK: - Metadata

    /// The `@setDataFrame("onMetaData", {...})` data message body. Servers
    /// use it for their dashboards (YouTube's "stream health" reads it).
    static func metadata(width: Int, height: Int, frameRate: Double,
                         videoKbps: Int, audioKbps: Int,
                         audioSampleRate: Double = 48000) -> Data {
        AMF0.encode([
            .string("@setDataFrame"),
            .string("onMetaData"),
            .ecmaArray([
                AMF0Pair("width", .number(Double(width))),
                AMF0Pair("height", .number(Double(height))),
                AMF0Pair("framerate", .number(frameRate)),
                AMF0Pair("videocodecid", .number(7)),
                AMF0Pair("videodatarate", .number(Double(videoKbps))),
                AMF0Pair("audiocodecid", .number(10)),
                AMF0Pair("audiodatarate", .number(Double(audioKbps))),
                AMF0Pair("audiosamplerate", .number(audioSampleRate)),
                AMF0Pair("audiosamplesize", .number(16)),
                AMF0Pair("stereo", .bool(true)),
                AMF0Pair("encoder", .string("streamit")),
            ]),
        ])
    }
}
