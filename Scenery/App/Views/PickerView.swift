import SceneryCore
import SwiftUI

/// The panel that drops down from the menu bar icon.
struct PickerView: View {
    @EnvironmentObject private var model: AppModel

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            if let lock = model.lock {
                LockBanner(lock: lock, wallpaperTitle: lockedWallpaperTitle)
            }

            if model.displays.count > 1 {
                displaySection
            }

            grid

            if model.hasLiveWallpaper {
                daySection
            }

            if let problem = model.problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.multicolor)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            footer
        }
        .padding(16)
        .frame(width: 420)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Wallpaper")
                    .font(.title3.weight(.semibold))
                Text(model.isUsingDemoCatalog ? "Demo collection" : "Approved collection")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isRefreshing {
                ProgressView()
                    .controlSize(.small)
            } else if !model.isUsingDemoCatalog {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Check for new wallpapers")
            }
        }
    }

    private var displaySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            DisplayMapView(
                displays: model.displays,
                previews: displayPreviews,
                spannedPreview: spannedPreview,
                highlighted: highlightedDisplays,
                isInteractive: model.selection.layout == .individual && model.lock == nil
            ) { display in
                model.focusedDisplayID = display.id
            }

            Picker("Displays", selection: Binding(
                get: { model.selection.layout },
                set: { model.setLayout($0) }
            )) {
                Text("Same on each").tag(DisplayLayout.same)
                Text("Span across").tag(DisplayLayout.span)
                Text("One per display").tag(DisplayLayout.individual)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .disabled(model.lock != nil)

            if let hint = layoutHint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var grid: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(model.catalog.selectable) { wallpaper in
                WallpaperTile(
                    wallpaper: wallpaper,
                    image: model.thumbnails[wallpaper.id],
                    isSelected: model.lock == nil && model.highlightedWallpaperID == wallpaper.id
                ) {
                    model.select(wallpaper)
                }
            }
        }
        .disabled(model.lock != nil)
        .opacity(model.lock == nil ? 1 : 0.45)
        .animation(.easeInOut(duration: 0.2), value: model.lock)
    }

    /// Shown while a wallpaper that follows the day is on screen: drag
    /// through the day and watch the desktop change.
    private var daySection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label("Follows your day", systemImage: "sun.max")
                Spacer()
                if model.previewHour != nil {
                    Button("Back to now") {
                        model.previewHour = nil
                    }
                    .buttonStyle(.borderless)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Slider(
                value: Binding(
                    get: { model.previewHour ?? model.currentHour },
                    set: { model.previewHour = $0 }
                ),
                in: 0...24
            )
            .controlSize(.small)
            .accessibilityLabel("Preview a time of day")

            HStack {
                Text("Midnight")
                Spacer()
                Text("Noon")
                Spacer()
                Text("Midnight")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .onDisappear {
            model.previewHour = nil
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            Toggle("Open at login", isOn: $model.launchAtLogin)
            Toggle("Pause video on battery", isOn: $model.pauseVideoOnBattery)
                .disabled(model.isBatterySettingManaged)
            Spacer()
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
        }
        .toggleStyle(.checkbox)
        .controlSize(.small)
        .font(.caption)
    }

    // MARK: - Derived values

    private var lockedWallpaperTitle: String? {
        model.resolutions.values.first?.wallpaper.title
    }

    private var focusedDisplayName: String? {
        let id = model.focusedDisplayID ?? model.displays.first?.id
        return model.displays.first { $0.id == id }?.name
    }

    private var layoutHint: String? {
        switch model.selection.layout {
        case .same:
            return nil
        case .span:
            return "One wallpaper flows across your displays, following their arrangement in System Settings."
        case .individual:
            guard model.lock == nil, let name = focusedDisplayName else { return nil }
            return "Choosing for \(name)"
        }
    }

    /// The single wallpaper drawn across the whole map, when spanning.
    private var spannedPreview: NSImage? {
        guard model.spanCanvas != nil, let id = model.resolutions.values.first?.wallpaper.id else { return nil }
        return model.thumbnails[id]
    }

    private var highlightedDisplays: Set<String> {
        if model.selection.sameOnAllDisplays || model.lock != nil {
            return Set(model.displays.map(\.id))
        }
        if let id = model.focusedDisplayID ?? model.displays.first?.id {
            return [id]
        }
        return []
    }

    /// The wallpaper each display is showing, as a small image for the map.
    private var displayPreviews: [String: NSImage] {
        var result: [String: NSImage] = [:]
        for display in model.displays {
            if let id = model.resolutions[display.id]?.wallpaper.id, let image = model.thumbnails[id] {
                result[display.id] = image
            }
        }
        return result
    }
}

/// Explains that IT has pinned the wallpaper, and for how long.
private struct LockBanner: View {
    let lock: AppModel.Lock
    let wallpaperTitle: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .foregroundStyle(.secondary)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var title: String {
        if case .takeover(let takeover) = lock, let message = takeover.message, !message.isEmpty {
            return message
        }
        return wallpaperTitle ?? "Wallpaper set by your company"
    }

    private var detail: String {
        switch lock {
        case .managed:
            return "Set by your company. Your own choice returns when this ends."
        case .takeover(let takeover):
            if let endsAt = takeover.endsAt {
                let day = endsAt.formatted(.dateTime.month(.wide).day())
                return "Set by your company until \(day). Your own choice returns after that."
            }
            return "Set by your company for now. Your own choice returns when this ends."
        }
    }
}
