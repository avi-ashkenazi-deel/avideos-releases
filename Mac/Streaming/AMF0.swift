import Foundation

/// Action Message Format 0 — the encoding RTMP uses for its command messages
/// (`connect`, `createStream`, `publish`, `_result`, `onStatus`) and for
/// `@setDataFrame/onMetaData`. Only the types those messages use are
/// supported; anything else on the wire stops decoding rather than guessing.
///
/// Pure value code: no networking, unit-tested in `RTMPTests`.
indirect enum AMF0Value: Equatable, Sendable {
    case number(Double)
    case bool(Bool)
    case string(String)
    /// Ordered key/value pairs. Order matters on the wire for some servers'
    /// logging and costs nothing to keep.
    case object([AMF0Pair])
    case null
    case undefined
    /// Associative ("ECMA") array — what onMetaData carries.
    case ecmaArray([AMF0Pair])
    case strictArray([AMF0Value])

    // MARK: Convenience accessors for parsing server replies

    var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var number: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    /// Looks up a key in an object or ECMA array.
    subscript(key: String) -> AMF0Value? {
        switch self {
        case .object(let pairs), .ecmaArray(let pairs):
            return pairs.first { $0.key == key }?.value
        default:
            return nil
        }
    }
}

struct AMF0Pair: Equatable, Sendable {
    var key: String
    var value: AMF0Value

    init(_ key: String, _ value: AMF0Value) {
        self.key = key
        self.value = value
    }
}

enum AMF0 {
    enum Marker: UInt8 {
        case number = 0x00
        case boolean = 0x01
        case string = 0x02
        case object = 0x03
        case null = 0x05
        case undefined = 0x06
        case ecmaArray = 0x08
        case objectEnd = 0x09
        case strictArray = 0x0A
        case longString = 0x0C
    }

    enum DecodeError: Error, Equatable {
        case truncated
        case unsupportedMarker(UInt8)
        case invalidUTF8
    }

    // MARK: - Encoding

    static func encode(_ values: [AMF0Value]) -> Data {
        var out = Data()
        for value in values { encode(value, into: &out) }
        return out
    }

    static func encode(_ value: AMF0Value, into out: inout Data) {
        switch value {
        case .number(let n):
            out.append(Marker.number.rawValue)
            out.appendBigEndian(n.bitPattern)
        case .bool(let b):
            out.append(Marker.boolean.rawValue)
            out.append(b ? 1 : 0)
        case .string(let s):
            let bytes = Data(s.utf8)
            if bytes.count > 0xFFFF {
                out.append(Marker.longString.rawValue)
                out.appendBigEndian(UInt32(bytes.count))
            } else {
                out.append(Marker.string.rawValue)
                out.appendBigEndian(UInt16(bytes.count))
            }
            out.append(bytes)
        case .object(let pairs):
            out.append(Marker.object.rawValue)
            encodePairs(pairs, into: &out)
        case .null:
            out.append(Marker.null.rawValue)
        case .undefined:
            out.append(Marker.undefined.rawValue)
        case .ecmaArray(let pairs):
            out.append(Marker.ecmaArray.rawValue)
            out.appendBigEndian(UInt32(pairs.count))
            encodePairs(pairs, into: &out)
        case .strictArray(let values):
            out.append(Marker.strictArray.rawValue)
            out.appendBigEndian(UInt32(values.count))
            for element in values { encode(element, into: &out) }
        }
    }

    /// Object-style body: (u16 key length, key, value)* then the 00 00 09
    /// end marker. Keys are "UTF-8-empty" strings — no type marker.
    private static func encodePairs(_ pairs: [AMF0Pair], into out: inout Data) {
        for pair in pairs {
            let key = Data(pair.key.utf8)
            out.appendBigEndian(UInt16(key.count))
            out.append(key)
            encode(pair.value, into: &out)
        }
        out.append(contentsOf: [0x00, 0x00, Marker.objectEnd.rawValue])
    }

    // MARK: - Decoding

    /// Decodes every value in `data` in order.
    static func decodeAll(_ data: Data) throws -> [AMF0Value] {
        var reader = ByteReader(data)
        var values: [AMF0Value] = []
        while !reader.isAtEnd {
            values.append(try decodeValue(&reader))
        }
        return values
    }

    static func decodeValue(_ reader: inout ByteReader) throws -> AMF0Value {
        let markerByte = try reader.readUInt8()
        guard let marker = Marker(rawValue: markerByte) else {
            throw DecodeError.unsupportedMarker(markerByte)
        }
        switch marker {
        case .number:
            return .number(Double(bitPattern: try reader.readUInt64()))
        case .boolean:
            return .bool(try reader.readUInt8() != 0)
        case .string:
            let length = Int(try reader.readUInt16())
            return .string(try reader.readUTF8(count: length))
        case .longString:
            let length = Int(try reader.readUInt32())
            return .string(try reader.readUTF8(count: length))
        case .object:
            return .object(try decodePairs(&reader))
        case .null:
            return .null
        case .undefined:
            return .undefined
        case .ecmaArray:
            _ = try reader.readUInt32()   // count hint; the end marker is authoritative
            return .ecmaArray(try decodePairs(&reader))
        case .strictArray:
            let count = Int(try reader.readUInt32())
            var values: [AMF0Value] = []
            values.reserveCapacity(min(count, 1024))
            for _ in 0..<count { values.append(try decodeValue(&reader)) }
            return .strictArray(values)
        case .objectEnd:
            throw DecodeError.unsupportedMarker(markerByte)
        }
    }

    private static func decodePairs(_ reader: inout ByteReader) throws -> [AMF0Pair] {
        var pairs: [AMF0Pair] = []
        while true {
            let keyLength = Int(try reader.readUInt16())
            if keyLength == 0 {
                // Empty key followed by the object-end marker.
                let end = try reader.readUInt8()
                guard end == Marker.objectEnd.rawValue else {
                    throw DecodeError.unsupportedMarker(end)
                }
                return pairs
            }
            let key = try reader.readUTF8(count: keyLength)
            pairs.append(AMF0Pair(key, try decodeValue(&reader)))
        }
    }
}

// MARK: - Byte helpers shared by the streaming code

/// A cursor over `Data` reading big-endian integers. Throws `.truncated`
/// instead of trapping on short input — network bytes are untrusted.
struct ByteReader {
    private let data: Data
    private(set) var offset: Int

    init(_ data: Data) {
        // Rebase so indices start at 0 even for a slice.
        self.data = Data(data)
        self.offset = 0
    }

    var isAtEnd: Bool { offset >= data.count }
    var remaining: Int { data.count - offset }

    mutating func readUInt8() throws -> UInt8 {
        guard remaining >= 1 else { throw AMF0.DecodeError.truncated }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readUInt16() throws -> UInt16 {
        let bytes = try readBytes(2)
        return UInt16(bytes[0]) << 8 | UInt16(bytes[1])
    }

    mutating func readUInt24() throws -> UInt32 {
        let bytes = try readBytes(3)
        return UInt32(bytes[0]) << 16 | UInt32(bytes[1]) << 8 | UInt32(bytes[2])
    }

    mutating func readUInt32() throws -> UInt32 {
        let bytes = try readBytes(4)
        return UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])
    }

    mutating func readUInt32LittleEndian() throws -> UInt32 {
        let bytes = try readBytes(4)
        return UInt32(bytes[3]) << 24 | UInt32(bytes[2]) << 16 | UInt32(bytes[1]) << 8 | UInt32(bytes[0])
    }

    mutating func readUInt64() throws -> UInt64 {
        let bytes = try readBytes(8)
        return bytes.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    }

    mutating func readBytes(_ count: Int) throws -> [UInt8] {
        guard count >= 0, remaining >= count else { throw AMF0.DecodeError.truncated }
        defer { offset += count }
        return Array(data[offset..<(offset + count)])
    }

    mutating func readData(_ count: Int) throws -> Data {
        Data(try readBytes(count))
    }

    mutating func readUTF8(count: Int) throws -> String {
        let bytes = try readBytes(count)
        guard let string = String(bytes: bytes, encoding: .utf8) else {
            throw AMF0.DecodeError.invalidUTF8
        }
        return string
    }
}

extension Data {
    mutating func appendBigEndian(_ value: UInt16) {
        append(UInt8(value >> 8))
        append(UInt8(value & 0xFF))
    }

    /// The low 24 bits, big-endian — RTMP timestamps and lengths.
    mutating func appendBigEndian24(_ value: UInt32) {
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    mutating func appendBigEndian(_ value: UInt32) {
        append(UInt8(value >> 24))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    mutating func appendLittleEndian(_ value: UInt32) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8(value >> 24))
    }

    mutating func appendBigEndian(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            append(UInt8((value >> UInt64(shift)) & 0xFF))
        }
    }
}
