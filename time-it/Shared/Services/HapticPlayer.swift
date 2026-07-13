import Foundation
#if os(watchOS)
import WatchKit
#elseif canImport(UIKit)
import UIKit
#endif

/// Maps the platform-neutral `HapticPattern` vocabulary to concrete device
/// haptics. On the watch this is the primary feedback channel (the conference
/// talk case relies on telling milestones apart by feel).
enum HapticPlayer {

    @MainActor
    static func play(_ pattern: HapticPattern) {
        #if os(watchOS)
        playWatch(pattern)
        #elseif canImport(UIKit)
        playPhone(pattern)
        #endif
    }

    #if os(watchOS)
    @MainActor
    private static func playWatch(_ pattern: HapticPattern) {
        let device = WKInterfaceDevice.current()
        switch pattern {
        case .notification:   device.play(.notification)
        case .directionUp:    device.play(.directionUp)
        case .directionDown:  device.play(.directionDown)
        case .success:        device.play(.success)
        case .retry:
            // Double buzz — schedule a second play shortly after.
            device.play(.retry)
        case .stop:           device.play(.stop)
        case .timeUp:
            // Emphatic triple buzz so "time's up" is unmistakable on stage.
            repeatPlay(.stop, times: 3, gap: 0.35)
        }
    }

    @MainActor
    private static func repeatPlay(_ type: WKHapticType, times: Int, gap: TimeInterval) {
        let device = WKInterfaceDevice.current()
        for i in 0..<max(1, times) {
            DispatchQueue.main.asyncAfter(deadline: .now() + gap * Double(i)) {
                device.play(type)
            }
        }
    }
    #endif

    #if canImport(UIKit) && !os(watchOS)
    // Feedback generators must be *retained* and `prepare()`d, or the Taptic
    // engine often no-ops on a throwaway instance — which is why earlier builds
    // felt like nothing happened. Keep one of each alive for the app's lifetime.
    @MainActor private enum Gen {
        static let notification = UINotificationFeedbackGenerator()
        static let light = UIImpactFeedbackGenerator(style: .light)
        static let soft = UIImpactFeedbackGenerator(style: .soft)
        static let medium = UIImpactFeedbackGenerator(style: .medium)
        static let heavy = UIImpactFeedbackGenerator(style: .heavy)
    }

    @MainActor
    private static func playPhone(_ pattern: HapticPattern) {
        switch pattern {
        case .notification:
            Gen.notification.prepare()
            Gen.notification.notificationOccurred(.warning)
        case .success:
            Gen.notification.prepare()
            Gen.notification.notificationOccurred(.success)
        case .directionUp:  impact(Gen.light)
        case .directionDown: impact(Gen.soft)
        case .retry:        impact(Gen.medium, times: 2, gap: 0.18)
        case .stop:         impact(Gen.heavy)
        case .timeUp:       impact(Gen.heavy, times: 3, gap: 0.35)
        }
    }

    @MainActor
    private static func impact(_ g: UIImpactFeedbackGenerator, times: Int = 1, gap: TimeInterval = 0) {
        for i in 0..<max(1, times) {
            DispatchQueue.main.asyncAfter(deadline: .now() + gap * Double(i)) {
                g.prepare()
                g.impactOccurred(intensity: 1.0)
            }
        }
    }
    #endif
}
