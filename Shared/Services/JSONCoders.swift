import Foundation

/// ISO-8601 JSON coders shared by the on-disk stores (highlights, saved
/// articles). Kept dependency-free so the Share Extension can link them.
extension JSONEncoder {
    static var iso: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }
}

extension JSONDecoder {
    static var iso: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
