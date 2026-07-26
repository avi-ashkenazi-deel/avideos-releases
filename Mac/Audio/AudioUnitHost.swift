import Foundation
import AVFoundation
import AudioToolbox
import AppKit
import os

/// Discovery + instantiation of Audio Units: Apple's built-ins for our four
/// stock inserts, and every installed third-party effect (the same plug-in
/// ecosystem GarageBand/Logic host — anything in /Library/Audio/Plug-Ins/
/// Components; Logic's own built-in plug-ins are not exposed to hosts).
final class AudioUnitHost {
    struct ComponentInfo: Identifiable, Hashable {
        let componentType: UInt32
        let subType: UInt32
        let manufacturer: UInt32
        let name: String
        let manufacturerName: String
        var id: String { "\(componentType)-\(subType)-\(manufacturer)" }
    }

    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "auhost")
    private var pluginWindows: [UUID: NSWindow] = [:]

    // MARK: - Discovery

    /// All installed third-party (and Apple) effect AUs, excluding the four
    /// we surface as built-ins.
    func availableThirdPartyEffects() -> [ComponentInfo] {
        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Effect,
            componentSubType: 0,
            componentManufacturer: 0,
            componentFlags: 0,
            componentFlagsMask: 0)
        let components = AVAudioUnitComponentManager.shared().components(matching: description)
        return components.compactMap { component in
            let desc = component.audioComponentDescription
            // Skip the ones we already expose with macro knobs.
            let builtinSubtypes: Set<UInt32> = [
                kAudioUnitSubType_DynamicsProcessor,
                kAudioUnitSubType_Delay,
                kAudioUnitSubType_NBandEQ,
                kAudioUnitSubType_MatrixReverb,
            ]
            if desc.componentManufacturer == kAudioUnitManufacturer_Apple,
               builtinSubtypes.contains(desc.componentSubType) {
                return nil
            }
            return ComponentInfo(componentType: desc.componentType,
                                 subType: desc.componentSubType,
                                 manufacturer: desc.componentManufacturer,
                                 name: component.name,
                                 manufacturerName: component.manufacturerName)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    // MARK: - Instantiation

    /// Built-in insert kinds → Apple AU descriptions.
    static func description(for kind: InsertEffect.Kind) -> AudioComponentDescription {
        func apple(_ subType: UInt32) -> AudioComponentDescription {
            AudioComponentDescription(componentType: kAudioUnitType_Effect,
                                      componentSubType: subType,
                                      componentManufacturer: kAudioUnitManufacturer_Apple,
                                      componentFlags: 0,
                                      componentFlagsMask: 0)
        }
        switch kind {
        case .compressor: return apple(kAudioUnitSubType_DynamicsProcessor)
        case .delay: return apple(kAudioUnitSubType_Delay)
        case .eq: return apple(kAudioUnitSubType_NBandEQ)
        case .reverb: return apple(kAudioUnitSubType_MatrixReverb)
        case .thirdParty(let type, let subType, let manufacturer, _):
            return AudioComponentDescription(componentType: type,
                                             componentSubType: subType,
                                             componentManufacturer: manufacturer,
                                             componentFlags: 0,
                                             componentFlagsMask: 0)
        }
    }

    /// Instantiates the node for an insert. Built-ins get their typed
    /// AVAudioUnit subclasses (needed for the macro curves); everything else
    /// goes through async AU instantiation.
    func instantiate(kind: InsertEffect.Kind) async throws -> AVAudioUnit {
        switch kind {
        case .delay:
            return AVAudioUnitDelay()
        case .eq:
            return AVAudioUnitEQ(numberOfBands: 3)
        case .reverb:
            return AVAudioUnitReverb()
        case .compressor, .thirdParty:
            let description = Self.description(for: kind)
            return try await withCheckedThrowingContinuation { continuation in
                AVAudioUnit.instantiate(with: description, options: []) { unit, error in
                    if let unit {
                        continuation.resume(returning: unit)
                    } else {
                        continuation.resume(throwing: error ?? NSError(
                            domain: "AudioUnitHost", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "AU instantiation failed"]))
                    }
                }
            }
        }
    }

    /// Restores a persisted fullState blob onto an instantiated node.
    func restoreState(_ data: Data?, on node: AVAudioUnit) {
        guard let data,
              let state = (try? PropertyListSerialization.propertyList(
                  from: data, options: [], format: nil)) as? [String: Any] else { return }
        node.auAudioUnit.fullState = state
    }

    // MARK: - Plug-in UI

    /// Opens the AU's own view in a floating window (generic parameter UIs
    /// are the AU host view's fallback; v1 shows a plain message if the AU
    /// provides no view controller).
    @MainActor
    func showPluginUI(for node: AVAudioUnit, insertID: UUID, title: String) {
        if let window = pluginWindows[insertID] {
            window.makeKeyAndOrderFront(nil)
            return
        }
        node.auAudioUnit.requestViewController { [weak self] viewController in
            Task { @MainActor in
                guard let self else { return }
                let content: NSViewController
                if let viewController {
                    content = viewController
                } else {
                    let fallback = NSViewController()
                    let label = NSTextField(labelWithString: "\(title) has no custom editor.\nUse the macro knob, or edit in another host.")
                    label.alignment = .center
                    fallback.view = label
                    content = fallback
                }
                let window = NSWindow(contentViewController: content)
                window.title = title
                window.styleMask = [.titled, .closable, .resizable]
                window.isReleasedWhenClosed = false
                window.level = .floating
                window.makeKeyAndOrderFront(nil)
                self.pluginWindows[insertID] = window
            }
        }
    }

    @MainActor
    func closePluginUI(insertID: UUID) {
        pluginWindows.removeValue(forKey: insertID)?.close()
    }
}
