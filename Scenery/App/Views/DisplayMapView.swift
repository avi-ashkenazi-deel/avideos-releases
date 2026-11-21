import SwiftUI

/// A miniature of the person's real desk: every monitor drawn at its true
/// relative size and position, each showing the wallpaper it currently has.
/// Clicking a monitor chooses which one the grid below is editing.
struct DisplayMapView: View {
    let displays: [Display]
    let previews: [String: NSImage]
    let highlighted: Set<String>
    let isInteractive: Bool
    let onSelect: (Display) -> Void

    private let gap: CGFloat = 3

    var body: some View {
        GeometryReader { proxy in
            let layout = MapLayout(displays: displays, in: proxy.size)
            ZStack(alignment: .topLeading) {
                ForEach(displays) { display in
                    let rect = layout.rect(for: display)
                    DisplayChip(
                        name: display.name,
                        image: previews[display.id],
                        isHighlighted: highlighted.contains(display.id),
                        isInteractive: isInteractive
                    ) {
                        onSelect(display)
                    }
                    .frame(width: max(rect.width - gap * 2, 8), height: max(rect.height - gap * 2, 8))
                    .offset(x: rect.minX + gap, y: rect.minY + gap)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .frame(height: 84)
    }

    /// Scales the global desktop down to fit the available space, centred.
    private struct MapLayout {
        let bounds: CGRect
        let scale: CGFloat
        let inset: CGSize

        init(displays: [Display], in size: CGSize) {
            let union = displays.reduce(CGRect.null) { $0.union($1.frame) }
            bounds = union.isNull ? CGRect(x: 0, y: 0, width: 1, height: 1) : union
            let fit = min(size.width / max(bounds.width, 1), size.height / max(bounds.height, 1))
            scale = fit.isFinite && fit > 0 ? fit : 1
            inset = CGSize(
                width: (size.width - bounds.width * scale) / 2,
                height: (size.height - bounds.height * scale) / 2
            )
        }

        func rect(for display: Display) -> CGRect {
            // AppKit measures from the bottom-left, SwiftUI from the top-left.
            CGRect(
                x: (display.frame.minX - bounds.minX) * scale + inset.width,
                y: (bounds.maxY - display.frame.maxY) * scale + inset.height,
                width: display.frame.width * scale,
                height: display.frame.height * scale
            )
        }
    }
}

private struct DisplayChip: View {
    let name: String
    let image: NSImage?
    let isHighlighted: Bool
    let isInteractive: Bool
    let action: () -> Void

    private let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)

    var body: some View {
        Button(action: action) {
            Color.clear
                .overlay {
                    if let image {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Rectangle().fill(.quaternary)
                    }
                }
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(
                        isHighlighted ? Color.accentColor : Color.primary.opacity(0.15),
                        lineWidth: isHighlighted ? 2 : 1
                    )
                }
                .opacity(isHighlighted ? 1 : 0.6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isInteractive)
        .animation(.easeInOut(duration: 0.18), value: isHighlighted)
        .help(name)
        .accessibilityLabel(name)
        .accessibilityAddTraits(isHighlighted ? .isSelected : [])
    }
}
