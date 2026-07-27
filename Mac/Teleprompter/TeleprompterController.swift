import AppKit
import Observation
import os

/// Owns teleprompter state, the scroll engine, the floating panel, local
/// hotkeys, and the phone-remote data protocol.
///
/// Remote protocol (mirrors web/guest/prompter.js):
///   in:  {type:"prompter", cmd:"play"|"pause"|"speed"|"jump"|"sync", value?}
///        - "speed" value is a ±0.1 delta on the multiplier
///        - "jump" value is a section id (UUID string)
///   out: {type:"prompter-state", sections:[{id,title}], playing:Bool,
///         speed:Double, activeSectionId:String?}
///        sent in reply to "sync" and after every state change.
@MainActor @Observable
final class TeleprompterController {
    static let fontSizeRange: ClosedRange<CGFloat> = 24...96
    static let opacityRange: ClosedRange<Double> = 0.3...1.0

    // MARK: - Observable state

    private(set) var script: ScriptDocument?
    private(set) var playing = false
    private(set) var speed: Double = 1.0
    private(set) var fontSize: CGFloat = 40
    private(set) var opacity: Double = 0.9
    private(set) var mirrored = false
    private(set) var clickThrough = false
    private(set) var activeSectionID: UUID?
    private(set) var panelVisible = false
    /// Bumped on jump/nudge so a paused `TimelineView` re-samples the offset.
    private(set) var manualScrollVersion = 0

    // MARK: - Wiring (injected by StudioController)

    /// Sends one data message to the LiveKit room. Transport is injected so
    /// this module never imports LiveKit.
    @ObservationIgnored var sendData: (([String: Any]) -> Void)?

    // MARK: - Internals

    @ObservationIgnored let store: ScriptStore
    @ObservationIgnored private let engine = TimedScrollDriver()
    @ObservationIgnored private var panel: TeleprompterPanel?
    @ObservationIgnored private var sectionOffsets: [UUID: CGFloat] = [:]
    @ObservationIgnored private var visibleHeight: CGFloat = 0
    @ObservationIgnored private var localKeyMonitor: Any?
    @ObservationIgnored private var globalKeyMonitor: Any?
    @ObservationIgnored private var trackingTimer: Timer?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "teleprompter")

    init(store: ScriptStore = .shared) {
        self.store = store
        if let recent = store.loadMostRecent() {
            script = recent
            activeSectionID = recent.sections.first?.id
        }
        installKeyMonitors()
    }

    /// Removes event monitors and the tracking timer. Call from app teardown;
    /// the controller normally lives for the app's lifetime.
    func shutdown() {
        if let localKeyMonitor { NSEvent.removeMonitor(localKeyMonitor) }
        if let globalKeyMonitor { NSEvent.removeMonitor(globalKeyMonitor) }
        localKeyMonitor = nil
        globalKeyMonitor = nil
        trackingTimer?.invalidate()
        trackingTimer = nil
    }

    // MARK: - Script

    func loadScript(_ document: ScriptDocument) {
        script = document
        sectionOffsets = [:]
        activeSectionID = document.sections.first?.id
        engine.jump(to: 0, at: now)
        manualScrollVersion += 1
        store.markOpened(document.id)
        publishState()
    }

    // MARK: - Transport

    func togglePlay() {
        playing ? pause() : play()
    }

    func play() {
        guard script != nil, !playing else { return }
        playing = true
        engine.play(at: now)
        startActiveSectionTracking()
        publishState()
    }

    func pause() {
        guard playing else { return }
        playing = false
        engine.pause(at: now)
        stopActiveSectionTracking()
        publishState()
    }

    func setSpeed(_ multiplier: Double) {
        // Round to one decimal so remote ±0.1 taps never accumulate float dust
        // in the published payload.
        let clamped = min(max(TimedScrollDriver.speedMultiplierRange.lowerBound, multiplier),
                          TimedScrollDriver.speedMultiplierRange.upperBound)
        let rounded = (clamped * 10).rounded() / 10
        guard rounded != speed else { return }
        speed = rounded
        engine.setSpeed(rounded, at: now)
        publishState()
    }

    func adjustSpeed(by delta: Double) {
        setSpeed(speed + delta)
    }

    func nudge(lines: Int) {
        engine.nudge(lines: lines, at: now)
        manualScrollVersion += 1
        refreshActiveSection()
    }

    func jump(toSectionID id: UUID) {
        guard let script, script.sections.contains(where: { $0.id == id }) else { return }
        engine.jump(to: sectionOffsets[id] ?? 0, at: now)
        manualScrollVersion += 1
        if activeSectionID != id {
            activeSectionID = id
        }
        publishState()
    }

    /// Per-scene binding: when the program switches scenes, jump to the first
    /// section bound to that scene (if any).
    func sceneDidChange(sceneID: UUID) {
        guard let section = script?.sections.first(where: { $0.sceneID == sceneID }) else { return }
        log.debug("Scene change → jumping to section \(section.displayTitle, privacy: .public)")
        jump(toSectionID: section.id)
    }

    // MARK: - Appearance

    func setFontSize(_ size: CGFloat) {
        fontSize = min(max(Self.fontSizeRange.lowerBound, size), Self.fontSizeRange.upperBound)
        pushLayoutToEngine()
    }

    func adjustFontSize(by delta: CGFloat) {
        setFontSize(fontSize + delta)
    }

    func setOpacity(_ value: Double) {
        opacity = min(max(Self.opacityRange.lowerBound, value), Self.opacityRange.upperBound)
        panel?.alphaValue = opacity
    }

    func toggleMirrored() {
        mirrored.toggle()
    }

    func toggleClickThrough() {
        clickThrough.toggle()
        panel?.setClickThrough(clickThrough)
    }

    // MARK: - Panel

    func toggleVisible() {
        panelVisible ? hidePanel() : showPanel()
    }

    func showPanel() {
        if panel == nil {
            panel = TeleprompterPanel(controller: self)
        }
        panel?.alphaValue = opacity
        panel?.setClickThrough(clickThrough)
        // Non-activating: the host's focus stays wherever it was.
        panel?.orderFrontRegardless()
        panelVisible = true
    }

    func hidePanel() {
        pause()
        panel?.orderOut(nil)
        panelVisible = false
    }

    func parkUnderCamera() {
        panel?.parkUnderCamera()
    }

    // MARK: - Scroll sampling (called by TeleprompterView)

    /// Content-space Y at the eye line for the given frame timestamp.
    func currentOffset(at date: Date) -> CGFloat {
        engine.offset(at: date.timeIntervalSinceReferenceDate)
    }

    var scrollLineHeight: CGFloat { engine.metrics.lineHeight }

    /// The view reports measured geometry after every layout pass.
    func updateLayout(panelWidth: CGFloat, visibleHeight: CGFloat, contentHeight: CGFloat, sectionOffsets: [UUID: CGFloat]) {
        self.visibleHeight = visibleHeight
        self.sectionOffsets = sectionOffsets
        engine.maxOffset = max(0, contentHeight)
        pushLayoutToEngine(width: panelWidth)
    }

    private func pushLayoutToEngine(width: CGFloat? = nil) {
        var metrics = engine.metrics
        metrics.fontSize = fontSize
        if let width { metrics.panelWidth = width }
        engine.updateLayout(metrics, at: now)
    }

    // MARK: - Remote protocol

    /// Entry point for decoded LiveKit data messages (host side).
    func handleDataMessage(_ message: [String: Any]) {
        guard message["type"] as? String == "prompter",
              let cmd = message["cmd"] as? String else { return }
        switch cmd {
        case "play":
            play()
        case "pause":
            pause()
        case "speed":
            let delta = (message["value"] as? NSNumber)?.doubleValue ?? 0
            adjustSpeed(by: delta)
        case "jump":
            if let idString = message["value"] as? String, let id = UUID(uuidString: idString) {
                jump(toSectionID: id)
            }
        case "sync":
            publishState()
        default:
            log.debug("Ignoring unknown prompter cmd \(cmd, privacy: .public)")
        }
    }

    private func publishState() {
        guard let sendData else { return }
        var payload: [String: Any] = [
            "type": "prompter-state",
            "sections": (script?.sections ?? []).map { ["id": $0.id.uuidString, "title": $0.displayTitle] },
            "playing": playing,
            "speed": speed,
        ]
        if let activeSectionID {
            payload["activeSectionId"] = activeSectionID.uuidString
        }
        sendData(payload)
    }

    // MARK: - Active section tracking

    /// While playing, a coarse timer (not the display link) recomputes which
    /// section sits at the eye line and republishes state on change. Kept off
    /// the render path so view bodies never mutate observable state.
    private func startActiveSectionTracking() {
        stopActiveSectionTracking()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshActiveSection()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        trackingTimer = timer
    }

    private func stopActiveSectionTracking() {
        trackingTimer?.invalidate()
        trackingTimer = nil
    }

    private func refreshActiveSection() {
        guard let script, !sectionOffsets.isEmpty else { return }
        let eyeOffset = engine.offset(at: now) + scrollLineHeight / 2
        var current = script.sections.first?.id
        for section in script.sections {
            guard let top = sectionOffsets[section.id] else { continue }
            if top <= eyeOffset { current = section.id } else { break }
        }
        if current != activeSectionID {
            activeSectionID = current
            publishState()
        }
    }

    // MARK: - Hotkeys

    /// Local monitor handles keys while any of our windows is key; the global
    /// monitor lets ⌘⌥ shortcuts work while another app (browser, slides) is
    /// frontmost.
    // verify on Mac: the global monitor only receives events once the app has
    // been granted Accessibility (Input Monitoring) permission, and it cannot
    // consume the event — the frontmost app still sees the keystroke.
    private func installKeyMonitors() {
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return event }
                return self.handleKeyDown(event, isGlobal: false) ? nil : event
            }
        }
        globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                _ = self?.handleKeyDown(event, isGlobal: true)
            }
        }
    }

    /// Returns true when the event was consumed.
    private func handleKeyDown(_ event: NSEvent, isGlobal: Bool) -> Bool {
        guard panelVisible else { return false }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        if modifiers == [.command, .option] {
            switch event.keyCode {
            case 123: adjustSpeed(by: -0.1); return true // ⌘⌥←
            case 124: adjustSpeed(by: 0.1); return true  // ⌘⌥→
            case 126: nudge(lines: -1); return true      // ⌘⌥↑
            case 125: nudge(lines: 1); return true       // ⌘⌥↓
            default: break
            }
        }

        // Space toggles transport only when the prompter panel itself is key
        // and the user isn't typing in a text field/editor anywhere.
        if !isGlobal, event.keyCode == 49, modifiers.isEmpty,
           panel?.isKeyWindow == true, !isTypingInText {
            togglePlay()
            return true
        }
        return false
    }

    /// True while a text view (including the shared field editor backing
    /// NSTextField/SwiftUI TextField) is first responder — hotkeys must not
    /// steal characters from the script editor.
    private var isTypingInText: Bool {
        guard let responder = NSApp.keyWindow?.firstResponder else { return false }
        return responder is NSTextView || responder is NSText
    }

    // MARK: - Clock

    // Date-based so it matches TimelineView's frame timestamps exactly.
    private var now: TimeInterval { Date().timeIntervalSinceReferenceDate }
}
