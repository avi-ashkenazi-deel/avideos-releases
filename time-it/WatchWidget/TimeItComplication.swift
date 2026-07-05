import WidgetKit
import SwiftUI

/// Watch-face complications for Time It. They're launchers: tapping any of them
/// opens the app to the timer list so you can start a timer from the wrist
/// without digging through the app grid.
@main
struct TimeItWatchWidgetBundle: WidgetBundle {
    var body: some Widget { TimeItComplication() }
}

private struct ComplicationEntry: TimelineEntry {
    let date: Date
}

private struct ComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> ComplicationEntry { ComplicationEntry(date: context.date) }

    func getSnapshot(in context: Context, completion: @escaping (ComplicationEntry) -> Void) {
        completion(ComplicationEntry(date: context.date))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        // Static launcher — nothing to refresh.
        completion(Timeline(entries: [ComplicationEntry(date: context.date)], policy: .never))
    }
}

struct TimeItComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TimeItComplication", provider: ComplicationProvider()) { _ in
            ComplicationView()
        }
        .configurationDisplayName("Time It")
        .description("Open Time It to start a timer.")
        .supportedFamilies([.accessoryCircular, .accessoryInline,
                            .accessoryRectangular, .accessoryCorner])
    }
}

private struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryInline:
            Label("Time It", systemImage: "timer")
        case .accessoryRectangular:
            HStack(spacing: 6) {
                Image(systemName: "timer")
                Text("Time It").fontWeight(.semibold)
            }
        case .accessoryCorner:
            Image(systemName: "timer")
                .font(.title2)
                .widgetLabel("Time It")
        default: // .accessoryCircular
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "timer").font(.title3)
            }
        }
    }
}

extension TimelineProviderContext {
    /// A single fixed date for the static launcher entry (avoids Date() at call
    /// sites and keeps snapshots stable).
    var date: Date { Date(timeIntervalSince1970: 0) }
}
