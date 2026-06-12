import SwiftUI

/// Floating mini-player, styled like Apple Podcasts: a rounded card that hovers
/// just above the tab bar whenever something is loaded, showing the sender logo,
/// title, and a play/pause button. Tap it to expand the full Now Playing view.
struct MiniPlayerBar: View {
    @EnvironmentObject private var player: EmailPlayerViewModel

    var body: some View {
        if let email = player.parsed?.email {
            HStack(spacing: 10) {
                Button {
                    player.isExpanded = true
                } label: {
                    HStack(spacing: 10) {
                        SenderAvatar(email: email, progress: nil, size: 38)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(email.subjectOrFallback)
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            Text(email.from.displayName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Button { player.togglePlayPause() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title2)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Button { player.clear() } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                // Thin playback progress along the bottom edge of the card.
                GeometryReader { geo in
                    Rectangle()
                        .fill(Color.accentColor)
                        .frame(width: geo.size.width * player.progress)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                }
                .frame(height: 2)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .floatingGlass(cornerRadius: 16)
            .padding(.horizontal, 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
