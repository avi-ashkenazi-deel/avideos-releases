import SwiftUI
import SafariServices

/// In-app browser: wraps `SFSafariViewController` so a link opens *inside*
/// VoiceInbox — sliding up from the bottom as a sheet — instead of kicking the
/// user out to the Safari app. It's the real Safari engine (reader mode, share,
/// find-in-page), just hosted in our sheet, and swiping down dismisses it.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: config)
        controller.dismissButtonStyle = .close
        controller.preferredControlTintColor = UIColor.tintColor
        return controller
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
