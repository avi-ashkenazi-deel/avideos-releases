import SwiftUI

/// Compact player pinned above the tab bar whenever something is loaded. Keeps
/// reading as you move between tabs and emails; tap it to expand the full Now
/// Playing view.
struct MiniPlayerBar: View {
    @EnvironmentObject private var player: EmailPlayerViewModel

    var body: some View {
        if let email = player.parsed?.email {
            VStack(spacing: 0) {
                ProgressView(value: player.progress)
                    .progressViewStyle(.linear)
                    .tint(.accentColor)

                HStack(spacing: 12) {
                    Button {
                        player.isExpanded = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "headphones")
                                .font(.title3)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(email.subjectOrFallback)
                                    .font(.subheadline.weight(.medium))
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
                            .font(.title3)
                            .frame(width: 28)
                    }

                    Button { player.clear() } label: {
                        Image(systemName: "xmark")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
