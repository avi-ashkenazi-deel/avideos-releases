import UIKit
import UniformTypeIdentifiers

/// Minimal share-sheet handler: grabs the shared URL (or a URL inside shared
/// text), saves it as a `pending` article in the shared app-group store, plays a
/// quick "card drops into the folder → Saved" animation, and dismisses. The main
/// app fetches + caches the content the next time it becomes active.
final class ShareViewController: UIViewController {

    private let backdrop = UIView()
    private let card = UIView()          // the "screenshot" that flies into the folder
    private let folder = UIImageView()   // the VoiceInbox tray it lands in
    private let check = UIImageView()    // success badge over the folder
    private let label = UILabel()
    private let tint = UIColor.systemBlue

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        setupUI()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Fade the dim backdrop in.
        UIView.animate(withDuration: 0.2) { self.backdrop.alpha = 1 }
        Task { await handleShare() }
    }

    // MARK: - UI

    private func setupUI() {
        backdrop.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        backdrop.alpha = 0
        backdrop.frame = view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(backdrop)

        let panel = UIView()
        panel.backgroundColor = .secondarySystemBackground
        panel.layer.cornerRadius = 24
        panel.layer.cornerCurve = .continuous
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)

        folder.image = UIImage(systemName: "tray.full.fill",
                               withConfiguration: UIImage.SymbolConfiguration(pointSize: 64, weight: .semibold))
        folder.tintColor = tint
        folder.contentMode = .center
        folder.translatesAutoresizingMaskIntoConstraints = false

        // A little portrait "screenshot" card that will dive into the folder.
        card.backgroundColor = tint
        card.layer.cornerRadius = 8
        card.layer.cornerCurve = .continuous
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.25
        card.layer.shadowRadius = 8
        card.layer.shadowOffset = CGSize(width: 0, height: 4)
        card.translatesAutoresizingMaskIntoConstraints = false

        check.image = UIImage(systemName: "checkmark.circle.fill",
                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 30, weight: .bold))
        check.tintColor = .systemGreen
        check.alpha = 0
        check.transform = CGAffineTransform(scaleX: 0.2, y: 0.2)
        check.translatesAutoresizingMaskIntoConstraints = false

        label.text = "Saving…"
        label.font = .preferredFont(forTextStyle: .headline)
        label.textColor = .label
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false

        panel.addSubview(folder)
        panel.addSubview(card)
        panel.addSubview(check)
        panel.addSubview(label)

        NSLayoutConstraint.activate([
            panel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            panel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            panel.widthAnchor.constraint(equalToConstant: 240),

            folder.topAnchor.constraint(equalTo: panel.topAnchor, constant: 56),
            folder.centerXAnchor.constraint(equalTo: panel.centerXAnchor),

            // Card sits just above the folder to start.
            card.widthAnchor.constraint(equalToConstant: 46),
            card.heightAnchor.constraint(equalToConstant: 60),
            card.centerXAnchor.constraint(equalTo: folder.centerXAnchor),
            card.bottomAnchor.constraint(equalTo: folder.topAnchor, constant: -2),

            check.centerXAnchor.constraint(equalTo: folder.centerXAnchor, constant: 20),
            check.centerYAnchor.constraint(equalTo: folder.centerYAnchor, constant: 2),

            label.topAnchor.constraint(equalTo: folder.bottomAnchor, constant: 22),
            label.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -20),
            label.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -28)
        ])
    }

    // MARK: - Save flow

    private func handleShare() async {
        guard let url = await extractURL() else {
            await finishWithMessage("No web link found to save.")
            return
        }
        let title = (extensionContext?.inputItems.first as? NSExtensionItem)?.attributedTitle?.string
        SavedArticleStorage.appendPending(url: url, title: title)
        await playSavedAnimation()
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    /// Card dives into the folder, the folder gives a little bounce, then a green
    /// check pops on and the label flips to "Saved".
    @MainActor
    private func playSavedAnimation() async {
        view.layoutIfNeeded()

        // Distance from the card's start (above the folder) down to the folder's
        // centre, so it looks like it drops inside.
        let dy = folder.center.y - card.center.y

        // Phase 1: the card dives in — translate down, shrink, spin slightly, fade.
        await withCheckedContinuation { cont in
            UIView.animate(withDuration: 0.55, delay: 0.1, options: [.curveEaseIn]) {
                self.card.transform = CGAffineTransform.identity
                    .translatedBy(x: 0, y: dy)
                    .scaledBy(x: 0.08, y: 0.08)
                    .rotated(by: .pi / 7)
                self.card.alpha = 0
            } completion: { _ in cont.resume() }
        }

        // Phase 2: folder bounce + success check + "Saved".
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        label.text = "Saved to VoiceInbox"

        UIView.animate(withDuration: 0.18, animations: {
            self.folder.transform = CGAffineTransform(scaleX: 1.28, y: 1.28)
        }, completion: { _ in
            UIView.animate(withDuration: 0.32,
                           delay: 0,
                           usingSpringWithDamping: 0.5,
                           initialSpringVelocity: 0.6,
                           options: []) {
                self.folder.transform = .identity
            }
        })

        UIView.animate(withDuration: 0.4,
                       delay: 0.12,
                       usingSpringWithDamping: 0.55,
                       initialSpringVelocity: 0.8,
                       options: []) {
            self.check.alpha = 1
            self.check.transform = .identity
        }

        // Let the success beat land before dismissing.
        try? await Task.sleep(nanoseconds: 900_000_000)
    }

    @MainActor
    private func finishWithMessage(_ message: String) async {
        card.isHidden = true
        folder.image = UIImage(systemName: "exclamationmark.triangle.fill",
                               withConfiguration: UIImage.SymbolConfiguration(pointSize: 48, weight: .semibold))
        folder.tintColor = .systemOrange
        label.text = message
        try? await Task.sleep(nanoseconds: 1_100_000_000)
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    // MARK: - URL extraction

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
}
