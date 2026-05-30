import Foundation

struct ElevenLabsVoice: Identifiable, Codable, Hashable, Sendable {
    let voiceID: String
    let name: String
    var id: String { voiceID }

    enum CodingKeys: String, CodingKey {
        case voiceID = "voice_id"
        case name
    }
}

/// Minimal client for the ElevenLabs text-to-speech API.
struct ElevenLabsClient: Sendable {
    var apiKey: String
    /// Default model; multilingual v2 is a good general-purpose choice.
    var modelID = "eleven_multilingual_v2"

    private let base = URL(string: "https://api.elevenlabs.io/v1")!

    /// List the voices available to this API key.
    func voices() async throws -> [ElevenLabsVoice] {
        var request = URLRequest(url: base.appendingPathComponent("voices"))
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.validate(response, data: data)
        struct Wrapper: Decodable { let voices: [ElevenLabsVoice] }
        return try JSONDecoder().decode(Wrapper.self, from: data).voices
    }

    /// Synthesize `text` with the given voice. Returns MP3 audio bytes.
    func synthesize(text: String, voiceID: String) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent("text-to-speech/\(voiceID)"))
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": text,
            "model_id": modelID,
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.validate(response, data: data)
        return data
    }

    private static func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw MailServiceError.network("No HTTP response from ElevenLabs")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 {
                throw MailServiceError.network("ElevenLabs rejected the API key (401).")
            }
            let body = String(data: data, encoding: .utf8) ?? ""
            throw MailServiceError.network("ElevenLabs error \(http.statusCode): \(body.prefix(200))")
        }
    }
}
