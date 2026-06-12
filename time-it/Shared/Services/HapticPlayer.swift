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
    @MainActor
    private static func playPhone(_ pattern: HapticPattern) {
        switch pattern {
        case .notification:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .directionUp:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .directionDown:
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .retry:
            let g = UIImpactFeedbackGenerator(style: .medium)
            g.impactOccurred()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { g.impactOccurred() }
        case .stop:
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case .timeUp:
            let g = UIImpactFeedbackGenerator(style: .heavy)
            for i in 0..<3 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35 * Double(i)) { g.impactOccurred() }
            }
        }
    }
    #endif
}
