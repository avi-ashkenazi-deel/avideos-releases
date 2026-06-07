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
    private let microsoftAuth = MicrosoftAuthSession(config: .placeholder)
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

    /// Whether Microsoft/Outlook sign-in is available (Azure client id filled in).
    var microsoftAvailable: Bool {
        #if os(iOS)
        return MicrosoftOAuthConfig.placeholder.isConfigured
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
        // Prefer a real backend if we have stored tokens for one.
        if googleAvailable, googleAuth.storedTokens != nil {
            await useGoogleBackend()
        } else if microsoftAvailable, microsoftAuth.storedTokens != nil {
            await useMicrosoftBackend()
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
        resetFolderToInbox()
        account = await mailService.account
        phase = .ready
    }

    func signInWithMicrosoft() async {
        guard microsoftAvailable else {
            errorMessage = "Outlook sign-in isn't configured yet. Showing the demo inbox."
            await continueWithDemo()
            return
        }
        do {
            _ = try await microsoftAuth.authenticate()
            await useMicrosoftBackend()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func useMicrosoftBackend() async {
        let auth = microsoftAuth
        mailService = MicrosoftMailService(tokenProvider: {
            try await auth.validAccessToken()
        })
        resetFolderToInbox()
        account = await mailService.account
        phase = .ready
    }

    /// Label ids differ per provider, so reset to the inbox when the backend changes.
    private func resetFolderToInbox() {
        settings.mailLabelId = "INBOX"
        settings.mailLabelName = "Inbox"
    }

    func signOut() {
        googleAuth.signOut()
        microsoftAuth.signOut()
        mailService = MockMailService()
        account = nil
        phase = .onboarding
    }
    #endif
}
