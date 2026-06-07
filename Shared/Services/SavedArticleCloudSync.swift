import Foundation
import CloudKit
import CryptoKit

/// Backs up the user's saved-link list to their **private iCloud**, keyed by the
/// email they signed in with, so the list survives uninstall/reinstall.
///
/// Privacy: this stores only the saved *links* and their metadata (URL, title,
/// excerpt, read state) as a single per-email JSON record. It never stores email
/// messages, and it doesn't sync the extracted article content (that's re-fetched
/// on the new device). Everything lives in the user's own private database.
actor SavedArticleCloudSync {

    static let shared = SavedArticleCloudSync()

    private let container = CKContainer(identifier: "iCloud.com.aviashkenazi.voiceinbox")
    private let recordType = "SavedArticleList"
    private let jsonKey = "articlesJSON"
    private let emailKey = "ownerEmail"

    private var db: CKDatabase { container.privateCloudDatabase }

    /// True only when this device has a usable iCloud account signed in.
    func isAvailable() async -> Bool {
        (try? await container.accountStatus()) == .available
    }

    /// The saved list stored for `email`, or nil if nothing's been saved yet.
    func fetch(forEmail email: String) async throws -> [SavedArticle]? {
        do {
            let record = try await db.record(for: recordID(for: email))
            guard let json = record[jsonKey] as? String, let data = json.data(using: .utf8) else {
                return []
            }
            return (try? JSONDecoder.iso.decode([SavedArticle].self, from: data)) ?? []
        } catch let error as CKError where error.code == .unknownItem {
            return nil
        }
    }

    func save(_ articles: [SavedArticle], forEmail email: String) async throws {
        guard let json = String(data: try JSONEncoder.iso.encode(articles), encoding: .utf8) else { return }
        try await saveJSON(json, email: email, allowRetry: true)
    }

    private func saveJSON(_ json: String, email: String, allowRetry: Bool) async throws {
        let id = recordID(for: email)
        let record: CKRecord
        do {
            record = try await db.record(for: id)
        } catch let error as CKError where error.code == .unknownItem {
            record = CKRecord(recordType: recordType, recordID: id)
        }
        record[jsonKey] = json
        record[emailKey] = email
        do {
            _ = try await db.save(record)
        } catch let error as CKError where error.code == .serverRecordChanged && allowRetry {
            // Another device wrote concurrently; refetch and try once more.
            try await saveJSON(json, email: email, allowRetry: false)
        }
    }

    /// Deterministic, ASCII-safe record name from the (lower-cased) email so the
    /// same address always maps to the same record.
    private func recordID(for email: String) -> CKRecord.ID {
        let digest = SHA256.hash(data: Data(email.lowercased().utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return CKRecord.ID(recordName: "savedArticles-\(hex)")
    }
}
