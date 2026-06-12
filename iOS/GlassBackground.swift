import SwiftUI

extension View {
    /// A floating "Liquid Glass" panel. On iOS 26+ this uses the system glass
    /// effect (which brings its own blur, highlight, and shadow); on earlier
    /// systems it falls back to a translucent material card with a hairline border
    /// and soft shadow so it still reads as a floating, layered surface.
    ///
    /// Used for the floating mini-player and the reading transport bar.
    @ViewBuilder
    func floatingGlass(cornerRadius: CGFloat = 22) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self
                .background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.06)))
                .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
        }
    }
}
