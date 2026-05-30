import Foundation
import Combine

/// Top-level app state: which backend we're talking to, who's signed in, and the
/// shared stores. Owns the choice between the demo backend and real Gmail.
@MainActor
final class AppState: ObservableObject {

    enum Phase {
        case onboarding
        case ready
    }

    @Published private(set) var phase: Phase = .onboarding
    @Published private(set) var account: MailAccount?
    @Published var errorMessage: String?

    let settings = AppSettings.shared
    let highlights = HighlightStore.shared

    private(set) var mailService: MailService

    #if os(iOS)
    private let googleAuth = GoogleAuthSession(config: .placeholder)
    #endif

    init() {
        // Default to the demo backend so the app is usable immediately.
        self.mailService = MockMailService()
    }

    /// Whether the real Google path is available (credentials filled in).
    var googleAvailable: Bool {
        #if os(iOS)
        return GoogleOAuthConfig.placeholder.isConfigured
        #else
        return false
        #endif
    }

    func bootstrap() async {
        if let account = await mailService.account {
            self.account = account
            self.phase = .ready
        }
        #if os(iOS)
        // If we have stored Google tokens, prefer the real backend.
        if googleAvailable, googleAuth.storedTokens != nil {
            await useGoogleBackend()
        }
        #endif
    }

    /// Continue with the bundled demo inbox (no sign-in).
    func continueWithDemo() async {
        mailService = MockMailService()
        account = await mailService.account
        phase = .ready
    }

    #if os(iOS)
    func signInWithGoogle() async {
        guard googleAvailable else {
            // No credentials yet: fall back to demo so onboarding still completes.
            errorMessage = "Google sign-in isn't configured yet. Showing the demo inbox."
            await continueWithDemo()
            return
        }
        do {
            _ = try await googleAuth.authenticate()
            await useGoogleBackend()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func useGoogleBackend() async {
        let auth = googleAuth
        mailService = GoogleMailService(tokenProvider: {
            try await auth.validAccessToken()
        })
        account = await mailService.account
        phase = .ready
    }

    func signOut() {
        googleAuth.signOut()
        mailService = MockMailService()
        account = nil
        phase = .onboarding
    }
    #endif
}
