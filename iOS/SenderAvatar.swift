import SwiftUI
import CryptoKit

/// Circular sender thumbnail wrapped in a listening-progress ring.
///
/// It tries to show a real image for the sender, in order of preference:
///   1. Gravatar — a profile photo/face for that address (personal senders).
///   2. Clearbit / Google favicon — the company logo for the sender's domain
///      (newsletters, brands, services).
///   3. The sender's initial as a last resort.
/// Results are cached per address so the list doesn't re-fetch while scrolling.
struct SenderAvatar: View {
    let email: Email
    var progress: ListeningProgress?
    var size: CGFloat = 46

    @StateObject private var loader = AvatarLoader()

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.secondary.opacity(0.2), lineWidth: 3)

            if let progress, progress.fraction > 0 {
                Circle()
                    .trim(from: 0, to: progress.fraction)
                    .stroke(progress.isComplete ? Color.green : Color.accentColor,
                            style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }

            content.padding(5)
        }
        .frame(width: size, height: size)
        .task(id: email.from.address) {
            await loader.load(address: email.from.address)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let image = loader.image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .clipShape(Circle())
        } else {
            initial
        }
    }

    private var initial: some View {
        ZStack {
            Circle().fill(email.isRead ? Color.gray.opacity(0.2) : Color.accentColor.opacity(0.2))
            Text(email.from.initial)
                .font(.headline)
                .foregroundStyle(email.isRead ? Color.secondary : Color.accentColor)
        }
    }
}

/// Loads a sender avatar from a chain of remote sources, caching the result
/// (and known misses) so each address is resolved at most once per launch.
@MainActor
final class AvatarLoader: ObservableObject {
    @Published private(set) var image: UIImage?

    private static let cache = NSCache<NSString, UIImage>()
    private static var misses = Set<String>()

    /// Generic mail providers whose domain favicon (the Gmail/Outlook logo) isn't
    /// a useful sender image — for these we only try Gravatar, then the initial.
    private static let genericProviders: Set<String> = [
        "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
        "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com",
        "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com"
    ]

    func load(address: String) async {
        let key = address.lowercased()
        if let cached = Self.cache.object(forKey: key as NSString) {
            image = cached
            return
        }
        if Self.misses.contains(key) || image != nil { return }

        for url in Self.candidates(for: key) {
            guard let data = try? await fetch(url), let img = UIImage(data: data) else { continue }
            Self.cache.setObject(img, forKey: key as NSString)
            image = img
            return
        }
        Self.misses.insert(key)
    }

    private func fetch(_ url: URL) async throws -> Data? {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              !data.isEmpty else {
            return nil
        }
        return data
    }

    private static func candidates(for address: String) -> [URL] {
        var urls: [URL] = []
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)

        // 1. Gravatar (face). `d=404` so it errors instead of returning a default.
        let hash = Insecure.MD5.hash(data: Data(trimmed.utf8))
            .map { String(format: "%02x", $0) }.joined()
        urls.append(URL(string: "https://www.gravatar.com/avatar/\(hash)?d=404&s=128")!)

        // 2/3. Company logo by domain, unless it's a generic mail provider.
        if let domain = trimmed.split(separator: "@").last.map(String.init),
           domain.contains("."), !genericProviders.contains(domain) {
            if let clearbit = URL(string: "https://logo.clearbit.com/\(domain)?size=128") {
                urls.append(clearbit)
            }
            if let favicon = URL(string: "https://www.google.com/s2/favicons?domain=\(domain)&sz=128") {
                urls.append(favicon)
            }
        }
        return urls
    }
}
