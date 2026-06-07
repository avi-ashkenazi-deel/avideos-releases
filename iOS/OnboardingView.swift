import SwiftUI

/// First-run screen. Connect a mailbox with Google or Outlook.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState
    @State private var isWorking = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            VStack(spacing: 16) {
                Image(systemName: "headphones")
                    .font(.system(size: 64, weight: .semibold))
                    .foregroundStyle(.tint)
                Text("VoiceInbox")
                    .font(.largeTitle.bold())
                Text("Listen to your email. Tap any message and press play — handle your inbox with your ears, your AirPods, or your watch.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()

            VStack(spacing: 12) {
                Button {
                    Task { await connectGoogle() }
                } label: {
                    Label("Continue with Google", systemImage: "envelope.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button {
                    Task { await connectMicrosoft() }
                } label: {
                    Label("Continue with Outlook", systemImage: "envelope.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .padding(.horizontal, 24)
            .disabled(isWorking)

            Spacer().frame(height: 12)
        }
        .overlay { if isWorking { ProgressView() } }
        .alert("Sign-in", isPresented: .constant(appState.errorMessage != nil)) {
            Button("OK") { appState.errorMessage = nil }
        } message: {
            Text(appState.errorMessage ?? "")
        }
    }

    private func connectGoogle() async {
        isWorking = true
        defer { isWorking = false }
        #if os(iOS)
        await appState.signInWithGoogle()
        #else
        await appState.continueWithDemo()
        #endif
    }

    private func connectMicrosoft() async {
        isWorking = true
        defer { isWorking = false }
        #if os(iOS)
        await appState.signInWithMicrosoft()
        #else
        await appState.continueWithDemo()
        #endif
    }
}
