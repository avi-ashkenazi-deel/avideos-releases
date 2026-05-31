import SwiftUI
import CryptoKit

/// Circular sender thumbnail — a Gravatar photo for the sender's address when
/// one exists, otherwise the sender's initial — wrapped in a ring that shows how
/// much of the email has been listened to (full green ring = finished).
struct SenderAvatar: View {
    let email: Email
    var progress: ListeningProgress?
    var size: CGFloat = 46

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

            avatar.padding(5)
        }
        .frame(width: size, height: size)
    }

    @ViewBuilder
    private var avatar: some View {
        if let url = Self.gravatarURL(for: email.from.address) {
            AsyncImage(url: url) { phase in
                if case .success(let image) = phase {
                    image.resizable().scaledToFill()
                } else {
                    initial
                }
            }
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

    /// Gravatar URL for an email address; `d=404` makes it 404 when there's no
    /// avatar so `AsyncImage` falls back to the initial.
    static func gravatarURL(for address: String) -> URL? {
        let normalized = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.contains("@") else { return nil }
        let hash = Insecure.MD5.hash(data: Data(normalized.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return URL(string: "https://www.gravatar.com/avatar/\(hash)?d=404&s=120")
    }
}
