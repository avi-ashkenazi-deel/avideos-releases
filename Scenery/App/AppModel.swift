import AppKit
import Combine
import SceneryCore
import ServiceManagement

/// The one object that knows everything: the approved catalog, the connected
/// displays, what the person picked, and what IT has pinned. The picker reads
/// from it and the wallpaper engine is driven by it.
@MainActor
final class AppModel: ObservableObject {
    /// Why the picker is locked, when it is.
    enum Lock: Equatable {
        case managed
        case takeover(Takeover)
    }

    @Published private(set) var catalog: Catalog = .empty
    @Published private(set) var displays: [Display] = []
    @Published private(set) var selection: SelectionState = Prefs.selection
    @Published private(set) var resolutions: [String: Resolution] = [:]
    @Published private(set) var lock: Lock?
    @Published private(set) var thumbnails: [String: NSImage] = [:]
    @Published private(set) var isRefreshing = false
    @Published private(set) var problem: String?
    /// The display the picker is editing when displays differ.
    @Published var focusedDisplayID: String?

    /// Set while someone drags the day slider: the hour (0 to 24) to show
    /// instead of the real time. `nil` means "now".
    @Published var previewHour: Double? {
        didSet {
            guard oldValue != previewHour else { return }
            previewChanged()
        }
    }

    @Published var pauseVideoOnBattery: Bool = Prefs.pauseVideoOnBattery {
        didSet {
            guard oldValue != pauseVideoOnBattery else { return }
            Prefs.pauseVideoOnBattery = pauseVideoOnBattery
            updatePlaybackPolicy()
        }
    }

    @Published var launchAtLogin: Bool = SMAppService.mainApp.status == .enabled {
        didSet {
            guard oldValue != launchAtLogin else { return }
            do {
                if launchAtLogin {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                problem = "Could not change the login setting: \(error.localizedDescription)"
            }
        }
    }

    var isBatterySettingManaged: Bool { Prefs.isManaged(Prefs.Key.pauseVideoOnBattery) }
    var isUsingDemoCatalog: Bool { service.source == .bundledDemo }

    private let supportDirectory: URL
    private let assets: AssetStore
    private let engine = WallpaperEngine()
    private let power = PowerMonitor()
    private var service: CatalogService

    private var started = false
    private var applyTask: Task<Void, Never>?
    private var thumbnailTask: Task<Void, Never>?
    private var refreshTimer: Timer?
    private var boundaryTimer: Timer?
    private var sunTimer: Timer?
    private var previewExpiry: Task<Void, Never>?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    init() {
        Prefs.registerDefaults()
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        supportDirectory = base.appendingPathComponent("Scenery", isDirectory: true)
        try? FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
        assets = AssetStore(supportDirectory: supportDirectory)
        service = CatalogService(source: .current, supportDirectory: supportDirectory)
    }

    // MARK: - Lifecycle

    func start() {
        guard !started else { return }
        started = true

        // Wallpapers are a "set once and forget" thing, so the app signs
        // itself up to launch at login the first time it runs. People can
        // switch that off in the picker. Debug builds skip this so a build
        // run from Xcode never registers itself.
        #if !DEBUG
        if !Prefs.defaults.bool(forKey: Prefs.Key.didSetUpLoginItem) {
            Prefs.defaults.set(true, forKey: Prefs.Key.didSetUpLoginItem)
            launchAtLogin = true
        }
        #endif

        power.onChange = { [weak self] in
            Task { @MainActor in self?.updatePlaybackPolicy() }
        }

        observe(.default, NSApplication.didChangeScreenParametersNotification) { $0.displaysChanged() }
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.activeSpaceDidChangeNotification) { $0.engine.reassertStills() }
        observe(workspace, NSWorkspace.didWakeNotification) { model in
            // Timers do not run during sleep, so catch up on anything missed.
            model.recompute()
            Task { await model.refresh() }
        }

        displays = Displays.current()
        if let cached = service.loadImmediately() {
            setCatalog(cached)
        }
        updatePlaybackPolicy()
        recompute()
        scheduleRefreshTimer()
        Task { await refresh() }
    }

    private func observe(
        _ center: NotificationCenter,
        _ name: Notification.Name,
        handler: @escaping @MainActor (AppModel) -> Void
    ) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                handler(self)
            }
        }
        observers.append((center, token))
    }

    // MARK: - Actions from the picker

    func select(_ wallpaper: Wallpaper) {
        guard lock == nil, wallpaper.selectable else { return }
        selection.select(wallpaper.id, forDisplay: focusedDisplayID ?? displays.first?.id)
        Prefs.selection = selection
        recompute()
    }

    func setLayout(_ layout: DisplayLayout) {
        let previous = selection.layout
        guard previous != layout, lock == nil else { return }

        if layout == .individual {
            // Start from what each display is showing right now.
            for display in displays {
                if let id = resolutions[display.id]?.wallpaper.id {
                    selection.perDisplay[display.id] = id
                }
            }
            focusedDisplayID = focusedDisplayID ?? displays.first?.id
        } else if previous == .individual {
            // Keep what is on the display being looked at.
            let keepFrom = focusedDisplayID ?? displays.first?.id
            if let keepFrom, let id = selection.wallpaperID(forDisplay: keepFrom) {
                selection.sharedWallpaperID = id
            }
            selection.perDisplay.removeAll()
        }
        selection.layout = layout
        Prefs.selection = selection
        recompute()
    }

    /// The area one wallpaper is stretched over, when it spans the displays.
    var spanCanvas: CGRect? {
        guard selection.layout == .span else { return nil }
        return SpanGeometry.canvas(for: displays.map(\.frame))
    }

    /// The wallpaper to highlight in the grid.
    var highlightedWallpaperID: String? {
        let displayID = selection.sameOnAllDisplays ? displays.first?.id : (focusedDisplayID ?? displays.first?.id)
        guard let displayID else { return nil }
        return resolutions[displayID]?.wallpaper.id
    }

    /// `scenery://refresh` — lets a management tool ask for an immediate check.
    func handle(url: URL) {
        guard url.scheme?.lowercased() == "scenery", url.host?.lowercased() == "refresh" else { return }
        Task { await refresh() }
    }

    // MARK: - Catalog

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        // The manifest location itself can be changed by device management.
        let source = CatalogService.Source.current
        if source != service.source {
            service = CatalogService(source: source, supportDirectory: supportDirectory)
            if let cached = service.loadImmediately() {
                setCatalog(cached)
            }
            scheduleRefreshTimer()
        }

        do {
            if let fresh = try await service.fetch() {
                setCatalog(fresh)
            }
            problem = nil
        } catch {
            // Keep showing the last good catalog; just say what went wrong.
            problem = error.localizedDescription
        }
        // Managed settings may have changed even if the manifest did not.
        recompute()
    }

    private func setCatalog(_ newCatalog: Catalog) {
        guard newCatalog != catalog else { return }
        catalog = newCatalog
        for issue in newCatalog.issues {
            NSLog("Scenery manifest: %@", issue)
        }
        loadThumbnails()
        let store = assets
        Task.detached(priority: .utility) { await store.prune(keeping: newCatalog) }
    }

    /// Builds the small previews. Walking the catalog here also downloads
    /// every approved wallpaper ahead of time, so switching is instant.
    private func loadThumbnails() {
        thumbnailTask?.cancel()
        let wallpapers = catalog.wallpapers
        let store = assets
        thumbnailTask = Task { [weak self] in
            var fresh: [String: NSImage] = [:]
            for wallpaper in wallpapers {
                if Task.isCancelled { return }
                let image = await Task.detached(priority: .utility) { () -> NSImage? in
                    guard let still = try? await store.still(for: wallpaper),
                          let thumbnail = Thumbnailer.thumbnail(of: still) else {
                        return nil
                    }
                    return NSImage(cgImage: thumbnail, size: .zero)
                }.value
                if Task.isCancelled { return }
                if let image {
                    fresh[wallpaper.id] = image
                    self?.thumbnails[wallpaper.id] = image
                }
            }
            // Drop previews of wallpapers that left the catalog.
            self?.thumbnails = fresh
        }
    }

    // MARK: - Deciding and applying

    private func displaysChanged() {
        displays = Displays.current()
        if let focused = focusedDisplayID, !displays.contains(where: { $0.id == focused }) {
            focusedDisplayID = displays.first?.id
        }
        recompute()
    }

    private func recompute() {
        let now = Date()
        let resolved = Resolver.resolve(
            catalog: catalog,
            selection: selection,
            displayIDs: displays.map(\.id),
            forcedWallpaperID: Prefs.forcedWallpaperID,
            now: now
        )
        resolutions = resolved

        switch resolved.values.first?.source {
        case .managed: lock = .managed
        case .takeover(let takeover): lock = .takeover(takeover)
        default: lock = nil
        }

        scheduleBoundaryTimer(after: now)
        updateSun(transition: 0)
        scheduleSunTimer()

        let canvas = spanCanvas
        var frames: [String: CGRect] = [:]
        for display in displays {
            frames[display.id] = display.frame
        }

        applyTask?.cancel()
        applyTask = Task { [weak self] in
            await self?.materializeAndApply(resolved, canvas: canvas, frames: frames)
        }
    }

    /// Makes sure the needed files are on disk, then hands them to the engine.
    ///
    /// `canvas` is set when one wallpaper spans the displays; each display
    /// then gets its own slice of the still, and its own part of the video.
    private func materializeAndApply(
        _ resolved: [String: Resolution],
        canvas: CGRect?,
        frames: [String: CGRect]
    ) async {
        let videoDisabled = Prefs.disableVideo
        var assignments: [String: WallpaperEngine.Assignment] = [:]

        for (displayID, resolution) in resolved {
            let wallpaper = resolution.wallpaper
            do {
                var still = try await assets.still(for: wallpaper)
                var video: URL?
                if wallpaper.kind == .video, !videoDisabled {
                    video = try await assets.file(for: wallpaper)
                }
                if let canvas, let frame = frames[displayID],
                   let slice = try? await assets.slice(of: still, canvas: canvas, display: frame) {
                    // If slicing fails the whole still is used, which is
                    // still an approved picture, just not a continuous one.
                    still = slice
                }
                assignments[displayID] = WallpaperEngine.Assignment(
                    stillURL: still, videoURL: video, canvas: canvas, palette: wallpaper.palette
                )
            } catch {
                // Leave this display as it is rather than blanking it.
                assignments[displayID] = engine.assignment(forDisplay: displayID)
                problem = error.localizedDescription
            }
            if Task.isCancelled { return }
        }
        engine.apply(assignments)
    }

    private func updatePlaybackPolicy() {
        engine.playbackAllowed = !power.areDisplaysAsleep
            && power.isSessionActive
            && !power.isLowPowerMode
            && !(pauseVideoOnBattery && power.isOnBattery)
    }

    // MARK: - Following the day

    /// `true` when a wallpaper that follows the day is on any display.
    var hasLiveWallpaper: Bool {
        resolutions.values.contains { $0.wallpaper.kind == .live }
    }

    /// The time right now as an hour of the day, for the day slider.
    var currentHour: Double {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: Date())
        return Double(parts.hour ?? 0) + Double(parts.minute ?? 0) / 60
    }

    /// Tells the engine where the Sun is, for the real time or for the hour
    /// being previewed.
    private func updateSun(transition: CFTimeInterval) {
        var moment = Date()
        if let previewHour {
            moment = Calendar.current.startOfDay(for: moment).addingTimeInterval(previewHour * 3600)
        }
        let place = Prefs.coordinates ?? Sun.approximateCoordinates(for: .current, at: moment)
        engine.setSun(
            Sun.position(at: moment, latitude: place.latitude, longitude: place.longitude),
            transition: transition
        )
    }

    private func previewChanged() {
        // Quick while dragging, gentle when going back to the real time.
        updateSun(transition: previewHour == nil ? 1.2 : 0.2)

        // A preview that is left alone goes back to the real time by itself,
        // so the desktop can never stay stuck at the wrong hour.
        previewExpiry?.cancel()
        previewExpiry = nil
        guard previewHour != nil else { return }
        previewExpiry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20 * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.previewHour = nil
        }
    }

    /// The sky changes far too slowly to need animating: one small step a
    /// minute is invisible, and the app sleeps in between.
    private func scheduleSunTimer() {
        guard hasLiveWallpaper else {
            sunTimer?.invalidate()
            sunTimer = nil
            return
        }
        guard sunTimer == nil else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.previewHour == nil else { return }
                self.updateSun(transition: 2)
            }
        }
        timer.tolerance = 15
        sunTimer = timer
    }

    // MARK: - Timers

    private func scheduleRefreshTimer() {
        refreshTimer?.invalidate()
        guard service.source != .bundledDemo else { return }
        let interval = Prefs.refreshInterval
        let timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        // A generous tolerance lets macOS batch this with other wake-ups.
        timer.tolerance = interval * 0.2
        refreshTimer = timer
    }

    /// Wakes the app at the exact moment a takeover starts or ends.
    private func scheduleBoundaryTimer(after now: Date) {
        boundaryTimer?.invalidate()
        boundaryTimer = nil
        guard let boundary = Resolver.nextBoundary(in: catalog, after: now) else { return }
        let timer = Timer(fire: boundary.addingTimeInterval(1), interval: 0, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.recompute() }
        }
        timer.tolerance = 5
        RunLoop.main.add(timer, forMode: .common)
        boundaryTimer = timer
    }
}
