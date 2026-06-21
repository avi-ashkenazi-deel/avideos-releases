import Foundation

/// The kind of workout a timer records on the Apple Watch when "Record as
/// workout" is on. Kept HealthKit-free here (the watch maps it to an
/// `HKWorkoutActivityType`) so the shared/model layer and tests don't depend on
/// HealthKit. Stored as a string for stable, backward-compatible decoding.
enum WorkoutKind: String, Codable, CaseIterable, Identifiable {
    case functionalStrength
    case traditionalStrength
    case core
    case hiit
    case cycling
    case running
    case walking
    case elliptical
    case rowing
    case yoga
    case other

    var id: String { rawValue }

    var name: String {
        switch self {
        case .functionalStrength: return "Functional Strength"
        case .traditionalStrength: return "Traditional Strength"
        case .core: return "Core Training"
        case .hiit: return "HIIT"
        case .cycling: return "Cycling"
        case .running: return "Running"
        case .walking: return "Walking"
        case .elliptical: return "Elliptical"
        case .rowing: return "Rowing"
        case .yoga: return "Yoga"
        case .other: return "Other"
        }
    }

    var symbol: String {
        switch self {
        case .functionalStrength: return "figure.strengthtraining.functional"
        case .traditionalStrength: return "figure.strengthtraining.traditional"
        case .core: return "figure.core.training"
        case .hiit: return "figure.highintensity.intervaltraining"
        case .cycling: return "figure.outdoor.cycle"
        case .running: return "figure.run"
        case .walking: return "figure.walk"
        case .elliptical: return "figure.elliptical"
        case .rowing: return "figure.rower"
        case .yoga: return "figure.yoga"
        case .other: return "figure.mixed.cardio"
        }
    }
}
