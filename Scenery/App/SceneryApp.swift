import AppKit
import SwiftUI

/// Scenery lives in the menu bar only: no Dock icon, no main window.
@main
struct SceneryApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Scenery", systemImage: "photo.on.rectangle.angled") {
            PickerView()
                .environmentObject(appDelegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The menu bar panel is only built when it is first opened, so the
        // work of applying wallpapers is started here instead.
        model.start()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            model.handle(url: url)
        }
    }
}
