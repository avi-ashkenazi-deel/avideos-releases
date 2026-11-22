import SceneryCore
import SwiftUI

/// One wallpaper in the picker grid.
struct WallpaperTile: View {
    let wallpaper: Wallpaper
    let image: NSImage?
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovering = false

    private let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 5) {
                preview
                HStack(spacing: 4) {
                    if wallpaper.kind == .video {
                        Image(systemName: "play.circle.fill")
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Video")
                    } else if wallpaper.kind == .live {
                        Image(systemName: "sun.max.fill")
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Follows the day")
                    }
                    Text(wallpaper.title)
                        .lineLimit(1)
                        .foregroundStyle(isSelected ? .primary : .secondary)
                }
                .font(.caption)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .help(wallpaper.title)
    }

    private var preview: some View {
        // The clear colour fixes the tile's shape; the image is then laid over
        // it and clipped, so previews of any proportion line up in the grid.
        Color.clear
            .aspectRatio(16.0 / 10.0, contentMode: .fit)
            .overlay {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity)
                } else {
                    Rectangle()
                        .fill(.quaternary)
                        .overlay {
                            ProgressView()
                                .controlSize(.small)
                        }
                }
            }
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            }
            .overlay {
                shape
                    .inset(by: -3)
                    .strokeBorder(Color.accentColor, lineWidth: 2.5)
                    .opacity(isSelected ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color.accentColor)
                        .font(.system(size: 15))
                        .padding(5)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(3)
            .scaleEffect(isHovering && !isSelected ? 1.03 : 1)
            .shadow(color: .black.opacity(isHovering ? 0.22 : 0.1), radius: isHovering ? 6 : 2, y: isHovering ? 3 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.8), value: isHovering)
            .animation(.spring(response: 0.28, dampingFraction: 0.8), value: isSelected)
            .animation(.easeOut(duration: 0.25), value: image != nil)
    }
}
