import SwiftUI

/// First-run onboarding: an animated splash, then a short feature showcase,
/// leading into sign-in. Shown once (gated by `hasCompletedWelcome` in RootView).
struct WelcomeView: View {
    /// Called when the user finishes (or skips) onboarding — hands off to sign-in.
    var onFinish: () -> Void

    @State private var page = 0

    private let features: [Feature] = [
        Feature(icon: "headphones",
                title: "Listen to your email",
                subtitle: "Tap any message and press play. Handle your inbox with your ears — hands-free and eyes-free.",
                tint: .blue),
        Feature(icon: "envelope.open.fill",
                title: "Marks read in your real inbox",
                subtitle: "Finish or swipe a message and it’s marked read (or unread) right in Gmail or Outlook — synced to all your devices.",
                tint: .green),
        Feature(icon: "airpods",
                title: "Control it with a squeeze",
                subtitle: "Press your AirPods to bookmark a moment and dictate a note out loud — completely hands-free.",
                tint: .purple),
        Feature(icon: "square.and.arrow.down.on.square.fill",
                title: "Save anything to listen later",
                subtitle: "Share a web page from your browser and VoiceInbox reads it to you — even offline.",
                tint: .orange)
    ]

    private var pageCount: Int { features.count + 1 }   // +1 for the splash
    private var isLastPage: Bool { page == pageCount - 1 }

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $page) {
                SplashPage().tag(0)
                ForEach(Array(features.enumerated()), id: \.offset) { idx, feature in
                    FeaturePage(feature: feature).tag(idx + 1)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()

            controls
        }
        .overlay(alignment: .topTrailing) {
            if !isLastPage {
                Button("Skip") { onFinish() }
                    .font(.subheadline.weight(.medium))
                    .padding()
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 20) {
            HStack(spacing: 8) {
                ForEach(0..<pageCount, id: \.self) { i in
                    Circle()
                        .fill(i == page ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 8, height: 8)
                        .animation(.easeInOut, value: page)
                }
            }

            Button {
                if isLastPage {
                    onFinish()
                } else {
                    withAnimation { page += 1 }
                }
            } label: {
                Text(isLastPage ? "Get Started" : "Continue")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    struct Feature {
        let icon: String
        let title: String
        let subtitle: String
        let tint: Color
    }
}

// MARK: - Splash

private struct SplashPage: View {
    @State private var textIn = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color.accentColor.opacity(0.9), Color.accentColor.opacity(0.5)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                AnimatedLogo()
                VStack(spacing: 8) {
                    Text("VoiceInbox")
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(.white)
                    Text("Your inbox, read aloud.")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.85))
                }
                .opacity(textIn ? 1 : 0)
                .offset(y: textIn ? 0 : 12)
            }
            .padding(.bottom, 80)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.6).delay(0.5)) { textIn = true }
        }
    }
}

/// The animated brand mark. This is a SwiftUI placeholder; when the Rive file
/// arrives, swap the inner `ZStack` for a `RiveViewModel(...)` view (add the
/// RiveRuntime Swift package and a single Rive view here).
private struct AnimatedLogo: View {
    @State private var appear = false
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .fill(.white.opacity(0.18))
                .frame(width: 200, height: 200)
                .scaleEffect(pulse ? 1.06 : 0.94)
            Circle()
                .fill(.white)
                .frame(width: 150, height: 150)
            Image(systemName: "headphones")
                .font(.system(size: 78, weight: .semibold))
                .foregroundStyle(Color.accentColor)
        }
        .scaleEffect(appear ? 1 : 0.5)
        .opacity(appear ? 1 : 0)
        .onAppear {
            withAnimation(.spring(response: 0.7, dampingFraction: 0.55)) { appear = true }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true).delay(0.7)) {
                pulse = true
            }
        }
    }
}

// MARK: - Feature page

private struct FeaturePage: View {
    let feature: WelcomeView.Feature
    @State private var appear = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 32, style: .continuous)
                    .fill(feature.tint.opacity(0.15))
                    .frame(width: 150, height: 150)
                Image(systemName: feature.icon)
                    .font(.system(size: 66, weight: .semibold))
                    .foregroundStyle(feature.tint)
            }
            .scaleEffect(appear ? 1 : 0.7)
            .opacity(appear ? 1 : 0)

            VStack(spacing: 14) {
                Text(feature.title)
                    .font(.title.bold())
                    .multilineTextAlignment(.center)
                Text(feature.subtitle)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            appear = false
            withAnimation(.spring(response: 0.6, dampingFraction: 0.7)) { appear = true }
        }
    }
}
