import SwiftUI

/// Button style for list rows: the whole row is the tap target and it briefly
/// highlights while pressed, so a tap visibly registers before the item opens.
struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                (configuration.isPressed ? Color.primary.opacity(0.09) : Color.clear)
                    .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            )
    }
}
