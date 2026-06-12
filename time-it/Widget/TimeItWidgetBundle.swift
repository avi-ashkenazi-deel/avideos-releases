import WidgetKit
import SwiftUI

/// The widget extension's entry point. Currently hosts just the Live Activity
/// (Lock Screen + Dynamic Island); home-screen widgets could be added here later.
@main
struct TimeItWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.2, *) {
            TimerLiveActivity()
        }
    }
}
