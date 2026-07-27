import Foundation
import Security
import os

/// Minimal Claude API client (raw URLSession — Swift has no official SDK).
/// Structured outputs guarantee schema-valid JSON, so every AI feature here
/// (take selection, clips, chapters, moment search) gets typed responses
/// with zero prompt-parsing. The user's API key lives in the Keychain.
final class ClaudeAPIClient {
    enum ClientError: LocalizedError {
        case missingAPIKey
        case refusal
        case httpError(Int, String)
        case emptyResponse

        var errorDescription: String? {
            switch self {
            case .missingAPIKey: "Add your Claude API key in Settings → AI."
            case .refusal: "Claude declined this request."
            case .httpError(let code, let body): "Claude API error \(code): \(body)"
            case .emptyResponse: "Claude returned no content."
            }
        }
    }

    static let keychainService = "com.aviashkenazi.streamit.claude"
    /// Most capable current model; per-request override available.
    var model = "claude-opus-5"
    var maxTokens = 8192

    private let session: URLSession
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "claude")

    init(session: URLSession = .shared) {
        self.session = session
    }

    // MARK: - Key management

    static func storedAPIKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func storeAPIKey(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
        ]
        SecItemDelete(query as CFDictionary)
        guard !key.isEmpty else { return }
        var add = query
        add[kSecValueData as String] = Data(key.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    // MARK: - Structured request

    /// Sends system+user text and returns the raw JSON `Data` of the
    /// structured output (guaranteed to match `schema` by the API).
    func structured(system: String,
                    user: String,
                    schema: [String: Any],
                    model overrideModel: String? = nil) async throws -> Data {
        guard let apiKey = Self.storedAPIKey(), !apiKey.isEmpty else {
            throw ClientError.missingAPIKey
        }

        let body: [String: Any] = [
            "model": overrideModel ?? model,
            "max_tokens": maxTokens,
            "system": system,
            "messages": [
                ["role": "user", "content": user],
            ],
            "output_config": [
                "format": [
                    "type": "json_schema",
                    "schema": schema,
                ],
            ],
        ]

        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 300

        // Retry on rate limits / overload with backoff.
        var lastError: Error = ClientError.emptyResponse
        for attempt in 0..<4 {
            if attempt > 0 {
                try await Task.sleep(for: .seconds(pow(2, Double(attempt))))
            }
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { continue }
                if http.statusCode == 429 || http.statusCode == 529 || http.statusCode >= 500 {
                    lastError = ClientError.httpError(http.statusCode, "retrying")
                    continue
                }
                guard http.statusCode == 200 else {
                    let bodyText = String(data: data, encoding: .utf8)?.prefix(300) ?? ""
                    throw ClientError.httpError(http.statusCode, String(bodyText))
                }
                return try Self.extractStructuredJSON(from: data)
            } catch let error as ClientError {
                throw error
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// Pulls the structured-output JSON text out of the response envelope.
    private static func extractStructuredJSON(from data: Data) throws -> Data {
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ClientError.emptyResponse
        }
        if let stopReason = envelope["stop_reason"] as? String, stopReason == "refusal" {
            throw ClientError.refusal
        }
        guard let content = envelope["content"] as? [[String: Any]] else {
            throw ClientError.emptyResponse
        }
        // Structured output arrives as the text of the (single) text block.
        for block in content {
            if block["type"] as? String == "text",
               let text = block["text"] as? String,
               let jsonData = text.data(using: .utf8) {
                return jsonData
            }
        }
        throw ClientError.emptyResponse
    }
}
