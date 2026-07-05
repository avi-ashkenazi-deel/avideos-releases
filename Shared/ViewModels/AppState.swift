import Foundation
import Combine

/// Top-level app state: which mailboxes are connected, which one is active, and
/// the shared stores. Supports several accounts at once (switch between them);
/// settings, saved links, and highlights are shared across accounts.
@MainActor
final class AppState: ObservableObject {

    enum Phase {
        /// Deciding what to show (checking stored accounts). Shows the splash, so
        /// a logged-in user never flashes the sign-in screen on launch.
        case launching
        case onboarding
        case ready
    }

    @Published private(set) var phase: Phase = .launching
    @Published private(set) var account: MailAccount? {
        didSet { syncSavedLinksAccount() }
    }
    @Published private(set) var connectedAccounts: [ConnectedAccount] = []
    @Published private(set) var activeAccountID: String?
    @Published var errorMessage: String?
    /// Listenable folders for the active account, so Settings can offer a
    /// "default folder" picker without its own fetch.
    @Published private(set) var mailLabels: [MailLabel] = []

    let settings = AppSettings.shared
    let highlights = HighlightStore.shared

    private(set) var mailService: MailService

    private let defaults = UserDefaults.standard
    private enum Key {
        static let accounts = "accounts.connected"
        static let active = "accounts.activeID"
    }
    /// Sentinel `activeAccountID` meaning "the bundled demo inbox".
    private static let demoID = "demo"

    #if DEBUG
    /// Debug-only: when true, every local launch shows the first-run onboarding
    /// (splash → feature tour → sign-in) so it can be reviewed. Connected accounts
    /// are kept, so set this back to false to resume normal launch (no re-sign-in).
    /// Has no effect on Release / TestFlight.
    static let previewOnboardingOnLaunch = false
    #endif

    #if os(iOS)
    private let googleAuth = GoogleAuthSession(config: .placeholder)
    private let microsoftAuth = MicrosoftAuthSession(config: .placeholder)
    #endif

    init() {
        self.mailService = MockMailService()
        loadAccounts()
    }

    var googleAvailable: Bool {
        #if os(iOS)
        return GoogleOAuthConfig.placeholder.isConfigured
        #else
        return false
        #endif
    }

    var microsoftAvailable: Bool {
        #if os(iOS)
        return MicrosoftOAuthConfig.placeholder.isConfigured
        #else
        return false
        #endif
    }

    // MARK: - Bootstrap

    func bootstrap() async {
        #if os(iOS)
        await migrateLegacyTokensIfNeeded()
        #endif
        #if DEBUG
        if Self.previewOnboardingOnLaunch {
            // Force the first-run experience for review (keeps stored accounts).
            UserDefaults.standard.set(false, forKey: "hasCompletedWelcome")
            phase = .onboarding
            return
        }
        #endif
        if activeAccountID == Self.demoID {
            await continueWithDemo()
            return
        }
        if let active = connectedAccounts.first(where: { $0.id == activeAccountID })
            ?? connectedAccounts.first {
            await activate(active)
            return
        }
        // Nothing connected. First run shows the welcome tour; after that (and on
        // every later launch) drop straight into the app with no mailbox — RSS and
        // Saved work, and the Inbox tab offers to connect email. No sign-in wall.
        if UserDefaults.standard.bool(forKey: "hasCompletedWelcome") {
            enterWithoutMail()
        } else {
            phase = .onboarding
        }
    }

    // MARK: - Demo

    /// Continue with the bundled demo inbox (no sign-in).
    func continueWithDemo() async {
        mailService = MockMailService()
        activeAccountID = Self.demoID
        persistAccounts()
        account = await mailService.account
        phase = .ready
    }

    /// Enter the app with no mailbox connected. Feeds and Saved work as usual;
    /// the Inbox tab shows a "connect your email" state. Used after signing out
    /// and on launch once the welcome tour is done — so nothing gates the app
    /// behind a sign-in wall.
    func enterWithoutMail() {
        mailService = NoMailService()
        activeAccountID = nil
        persistAccounts()
        account = nil
        phase = .ready
    }

    // MARK: - Persistence

    private func loadAccounts() {
        if let data = defaults.data(forKey: Key.accounts),
           let list = try? JSONDecoder().decode([ConnectedAccount].self, from: data) {
            connectedAccounts = list
        }
        activeAccountID = defaults.string(forKey: Key.active)
    }

    private func persistAccounts() {
        if let data = try? JSONEncoder().encode(connectedAccounts) {
            defaults.set(data, forKey: Key.accounts)
        }
        defaults.set(activeAccountID, forKey: Key.active)
    }

    /// Back up saved links under the real signed-in email (skip the demo account),
    /// so the list follows the user across uninstall/reinstall via their iCloud.
    private func syncSavedLinksAccount() {
        let email = (account?.provider == .demo) ? nil : account?.emailAddress
        SavedArticleStore.shared.configureCloud(email: email)
    }

    /// Build the backend for `account`, make it active, and go to the inbox.
    private func activate(_ account: ConnectedAccount) async {
        switch account.provider {
        case .demo:
            mailService = MockMailService()
        #if os(iOS)
        case .google:
            let key = account.tokenKey
            let base = GoogleMailService(tokenProvider: { try await GoogleAuthSession.validAccessToken(key: key) })
            mailService = CachingMailService(base: base, accountID: account.id)
        case .microsoft:
            let key = account.tokenKey
            let base = MicrosoftMailService(tokenProvider: { try await MicrosoftAuthSession.validAccessToken(key: key) })
            mailService = CachingMailService(base: base, accountID: account.id)
        #else
        default:
            mailService = MockMailService()
        #endif
        }
        activeAccountID = account.id
        persistAccounts()
        // Open to the chosen default folder if it belongs to this account (label
        // ids are account-specific); otherwise the inbox. This is what makes
        // "land on Newsletters" stick across launches instead of always resetting.
        if settings.defaultMailLabelAccountID == account.id, !settings.defaultMailLabelId.isEmpty {
            settings.mailLabelId = settings.defaultMailLabelId
            settings.mailLabelName = settings.defaultMailLabelName
        } else {
            settings.mailLabelId = "INBOX"
            settings.mailLabelName = "Inbox"
        }
        // Use the stored identity immediately so launch is instant and never blocks
        // on the network. Fetching the live profile offline can hang until timeout —
        // that delay is what made a cold offline launch look like it logged you out.
        self.account = MailAccount(provider: account.provider,
                                   emailAddress: account.email,
                                   displayName: account.displayName)
        phase = .ready
        mailLabels = []
        // Best-effort: refresh the live profile + folder list in the background.
        let service = mailService
        Task { @MainActor [weak self] in
            if let live = await service.account, !live.emailAddress.isEmpty {
                self?.account = live
            }
            await self?.loadMailLabels()
        }
    }

    /// Fetch the active account's listenable folders (for the Settings default-
    /// folder picker). Best-effort; leaves the list empty on failure.
    func loadMailLabels() async {
        guard let fetched = try? await mailService.fetchLabels() else { return }
        mailLabels = fetched
            .filter { $0.isListenable }
            .sorted { ($0.sortRank, $0.displayName) < ($1.sortRank, $1.displayName) }
    }

    #if os(iOS)

    // MARK: - Connect / switch / remove (iOS)

    func signInWithGoogle() async { await addAccount(provider: .google) }
    func signInWithMicrosoft() async { await addAccount(provider: .microsoft) }

    /// The provider of the currently active account (nil for demo / none).
    var activeProvider: MailAccount.Provider? {
        connectedAccounts.first(where: { $0.id == activeAccountID })?.provider
    }

    /// Re-run OAuth for the active account when its sign-in expired or was revoked.
    /// Because the account id is derived from provider+email, this replaces the
    /// dead tokens in place and reactivates the same account — highlights, notes,
    /// saved links, and progress are untouched. This is the supported recovery
    /// from "it stopped syncing": reconnect, never delete the app.
    func reconnectActiveAccount() async {
        guard let provider = activeProvider else { return }
        await addAccount(provider: provider)
    }

    /// Run the OAuth flow for `provider`, resolve the email, store its tokens, and
    /// make it the active account. Adding a second mailbox switches to it.
    func addAccount(provider: MailAccount.Provider) async {
        if provider == .google, !googleAvailable {
            errorMessage = "Google sign-in isn't configured yet. Showing the demo inbox."
            await continueWithDemo(); return
        }
        if provider == .microsoft, !microsoftAvailable {
            errorMessage = "Outlook sign-in isn't configured yet. Showing the demo inbox."
            await continueWithDemo(); return
        }
        do {
            let tokens: GoogleTokens
            switch provider {
            case .google: tokens = try await googleAuth.authenticate()
            case .microsoft: tokens = try await microsoftAuth.authenticate()
            default: return
            }
            // Resolve the email with the fresh access token before we know the key.
            let access = tokens.accessToken
            let probe: MailService = provider == .google
                ? GoogleMailService(tokenProvider: { access })
                : MicrosoftMailService(tokenProvider: { access })
            guard let profile = await probe.account, !profile.emailAddress.isEmpty else {
                errorMessage = "Couldn't read that account's email address."
                return
            }
            let connected = ConnectedAccount(provider: provider,
                                             email: profile.emailAddress,
                                             displayName: profile.displayName)
            switch provider {
            case .google: GoogleAuthSession.store(tokens, key: connected.tokenKey)
            case .microsoft: MicrosoftAuthSession.store(tokens, key: connected.tokenKey)
            default: break
            }
            connectedAccounts.removeAll { $0.id == connected.id }
            connectedAccounts.append(connected)
            persistAccounts()
            await activate(connected)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func switchTo(_ id: String) async {
        guard let account = connectedAccounts.first(where: { $0.id == id }), id != activeAccountID else { return }
        await activate(account)
    }

    func removeAccount(_ id: String) async {
        guard let account = connectedAccounts.first(where: { $0.id == id }) else { return }
        clearTokens(for: account)
        connectedAccounts.removeAll { $0.id == id }
        if activeAccountID == id { activeAccountID = nil }
        persistAccounts()
        if let next = connectedAccounts.first {
            await activate(next)
        } else {
            enterWithoutMail()
        }
    }

    /// Sign out of every account. Stays in the app with no mailbox (Feeds + Saved
    /// still work); the Inbox tab offers to reconnect — no forced onboarding.
    func signOut() {
        for account in connectedAccounts { clearTokens(for: account) }
        connectedAccounts = []
        enterWithoutMail()
    }

    private func clearTokens(for account: ConnectedAccount) {
        switch account.provider {
        case .google: GoogleAuthSession.store(nil, key: account.tokenKey)
        case .microsoft: MicrosoftAuthSession.store(nil, key: account.tokenKey)
        default: break
        }
    }

    /// One-time migration from the old single-account token keys to the new
    /// per-account storage, so already signed-in users stay signed in.
    private func migrateLegacyTokensIfNeeded() async {
        guard connectedAccounts.isEmpty else { return }
        // Migration probes the network; skip it offline so a cold launch with no
        // migrated accounts yet doesn't hang on a timeout.
        guard NetworkMonitor.shared.isOnline else { return }
        if let tokens = GoogleAuthSession.tokens(key: KeychainStore.Account.googleTokens) {
            let probe = GoogleMailService(tokenProvider: {
                try await GoogleAuthSession.validAccessToken(key: KeychainStore.Account.googleTokens)
            })
            if let p = await probe.account, !p.emailAddress.isEmpty {
                let acc = ConnectedAccount(provider: .google, email: p.emailAddress, displayName: p.displayName)
                GoogleAuthSession.store(tokens, key: acc.tokenKey)
                GoogleAuthSession.store(nil, key: KeychainStore.Account.googleTokens)
                connectedAccounts.append(acc)
                if activeAccountID == nil { activeAccountID = acc.id }
            }
        }
        if let tokens = MicrosoftAuthSession.tokens(key: KeychainStore.Account.microsoftTokens) {
            let probe = MicrosoftMailService(tokenProvider: {
                try await MicrosoftAuthSession.validAccessToken(key: KeychainStore.Account.microsoftTokens)
            })
            if let p = await probe.account, !p.emailAddress.isEmpty {
                let acc = ConnectedAccount(provider: .microsoft, email: p.emailAddress, displayName: p.displayName)
                MicrosoftAuthSession.store(tokens, key: acc.tokenKey)
                MicrosoftAuthSession.store(nil, key: KeychainStore.Account.microsoftTokens)
                connectedAccounts.append(acc)
                if activeAccountID == nil { activeAccountID = acc.id }
            }
        }
        if !connectedAccounts.isEmpty { persistAccounts() }
    }
    #endif
}
