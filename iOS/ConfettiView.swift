import SwiftUI

/// A lightweight, dependency-free confetti burst: colored pieces fall from the
/// top with random horizontal positions, spin, and timing, fading as they go.
/// Purely decorative — it never intercepts touches. Meant to sit briefly over a
/// celebration overlay (e.g. finishing every item in your feeds).
struct ConfettiView: View {
    struct Piece: Identifiable {
        let id = UUID()
        let x: CGFloat          // 0...1 horizontal start (fraction of width)
        let delay: Double
        let duration: Double
        let color: Color
        let size: CGFloat
        let spin: Double        // total degrees of rotation over the fall
    }

    private let pieces: [Piece]
    @State private var launched = false

    init(count: Int = 90) {
        let palette: [Color] = [.red, .orange, .yellow, .green, .blue, .purple, .pink, .mint]
        pieces = (0..<count).map { _ in
            Piece(
                x: .random(in: 0...1),
                delay: .random(in: 0...0.5),
                duration: .random(in: 1.6...2.8),
                color: palette.randomElement() ?? .blue,
                size: .random(in: 6...11),
                spin: .random(in: -720...720)
            )
        }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(pieces) { piece in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(piece.color)
                        .frame(width: piece.size, height: piece.size * 1.6)
                        .rotationEffect(.degrees(launched ? piece.spin : 0))
                        .position(
                            x: piece.x * geo.size.width,
                            y: launched ? geo.size.height + 40 : -40
                        )
                        .opacity(launched ? 0 : 1)
                        .animation(
                            .easeIn(duration: piece.duration).delay(piece.delay),
                            value: launched
                        )
                }
            }
        }
        .allowsHitTesting(false)
        .onAppear { launched = true }
    }
}
