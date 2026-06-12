import Foundation

/// What kind of feedback a milestone produces. A milestone can be both
/// spoken *and* haptic at once (e.g. the gym case wants voice; the talk case
/// wants haptic; some milestones want both).
struct AlertStyle: OptionSet, Codable, Hashable {
    let rawValue: Int

    static let voice  = AlertStyle(rawValue: 1 << 0)
    static let haptic = AlertStyle(rawValue: 1 << 1)

    static let voiceAndHaptic: AlertStyle = [.voice, .haptic]

    var includesVoice: Bool { contains(.voice) }
    var includesHaptic: Bool { contains(.haptic) }
}
