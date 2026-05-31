import UIKit
import UniformTypeIdentifiers

/// Minimal share-sheet handler: grabs the shared URL (or a URL inside shared
/// text), saves it as a `pending` article in the shared app-group store, shows a
/// brief confirmation, and dismisses. The main app fetches + caches the content
/// the next time it becomes active.
final class ShareViewController: UIViewController {

    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.0)
        setupConfirmation()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await handleShare() }
    }

    private func setupConfirmation() {
        let card = UIView()
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false

        label.text = "Saving to VoiceInbox…"
        label.font = .preferredFont(forTextStyle: .headline)
        label.textColor = .label
        label.numberOfLines = 0
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(card)
        card.addSubview(label)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            card.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),

            label.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            label.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -24),
            label.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24)
        ])
    }

    private func handleShare() async {
        guard let url = await extractURL() else {
            await finish(message: "No web link found to save.")
            return
        }
        let title = (extensionContext?.inputItems.first as? NSExtensionItem)?.attributedTitle?.string
        SavedArticleStorage.appendPending(url: url, title: title)
        await finish(message: "Saved to VoiceInbox")
    }

    /// Look through the shared attachments for a URL, or a URL embedded in text.
    private func extractURL() async -> URL? {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        // Prefer an explicit URL attachment (Safari, most apps).
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await loadURL(from: provider, type: UTType.url.identifier) {
                return url
            }
        }
        // Fall back to plain text that contains a URL (some readers, e.g. Feedly).
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let url = try? await loadURL(from: provider, type: UTType.plainText.identifier) {
                return url
            }
        }
        return nil
    }

    private func loadURL(from provider: NSItemProvider, type: String) async throws -> URL? {
        let item = try await provider.loadItem(forTypeIdentifier: type, options: nil)
        switch item {
        case let url as URL where url.scheme?.hasPrefix("http") == true:
            return url
        case let data as Data:
            return Self.firstHTTPURL(in: String(decoding: data, as: UTF8.self))
        case let string as String:
            return Self.firstHTTPURL(in: string)
        default:
            return nil
        }
    }

    private static func firstHTTPURL(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        let match = detector?.firstMatch(in: text, range: range)
        if let url = match?.url, url.scheme?.hasPrefix("http") == true {
            return url
        }
        return nil
    }

    @MainActor
    private func finish(message: String) async {
        label.text = message
        try? await Task.sleep(nanoseconds: 700_000_000)
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
