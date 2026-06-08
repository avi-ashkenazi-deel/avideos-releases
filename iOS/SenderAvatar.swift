import SwiftUI
import CryptoKit

/// Circular sender thumbnail wrapped in a listening-progress ring.
///
/// It tries to show a real image for the sender, in order of preference:
///   1. Gravatar — a profile photo/face for that address (personal senders).
///   2. Clearbit / Google favicon — the company logo for the sender's domain
///      (newsletters, brands, services).
/// If none of those load, the avatar shows **nothing** and collapses to zero
/// size, so the surrounding row text fills the space (no placeholder bubble).
/// Results are cached per address so the list doesn't re-fetch while scrolling.
struct SenderAvatar: View {
    let email: Email
    var progress: ListeningProgress?
    var size: CGFloat = 46
    /// Horizontal gap to reserve *after* the avatar, applied only when an image
    /// is actually shown. With no image the whole view (and this gap) collapses.
    var trailingSpace: CGFloat = 0

    @StateObject private var loader = AvatarLoader()

    private var hasImage: Bool { loader.image != nil }

    var body: some View {
        ZStack {
            if let image = loader.image {
                Circle()
                    .stroke(Color.secondary.opacity(0.2), lineWidth: 3)

                if let progress, progress.fraction > 0 {
                    Circle()
                        .trim(from: 0, to: progress.fraction)
                        .stroke(progress.isComplete ? Color.green : Color.accentColor,
                                style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }

                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .clipShape(Circle())
                    .padding(5)
            }
            // No image → empty ZStack, collapsed to 0×0 by the frame below. (The
            // ZStack still exists, so the .task keeps running to attempt the load.)
        }
        .frame(width: hasImage ? size : 0, height: hasImage ? size : 0)
        .padding(.trailing, hasImage ? trailingSpace : 0)
        .task(id: email.from.address) {
            await loader.load(address: email.from.address)
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

    func load(address: String) async {
        let key = address.lowercased()
        if let cached = Self.cache.object(forKey: key as NSString) {
            image = cached
            return
        }
        if Self.misses.contains(key) || image != nil { return }

        for url in SenderImage.candidateURLs(forAddress: key) {
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
}
