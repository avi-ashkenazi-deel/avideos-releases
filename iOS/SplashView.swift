import SwiftUI

/// Shown while `AppState` decides whether you're signed in, so a logged-in user
/// never flashes the sign-in screen on launch. Also covers the brief offline
/// bootstrap. A simple animated brand mark; replace with the Rive/logo later.
struct SplashView: View {
    @State private var animate = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.06, green: 0.06, blue: 0.13), .black],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 20) {
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.18))
                        .frame(width: 132, height: 132)
                        .scaleEffect(animate ? 1.12 : 0.88)
                    Image(systemName: "envelope.open.fill")
                        .font(.system(size: 52, weight: .semibold))
                        .foregroundStyle(.white)
                        .scaleEffect(animate ? 1.0 : 0.9)
                }

                Text("VoiceInbox")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)

                ProgressView()
                    .tint(.white.opacity(0.7))
                    .padding(.top, 2)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                animate = true
            }
        }
    }
}
