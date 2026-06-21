import Foundation
#if os(watchOS)
import HealthKit
#endif

/// Keeps the watch app foregrounded for the duration of a session by running an
/// `HKWorkoutSession`. Without this, watchOS suspends the app when the wrist
/// drops and milestone haptics would be delayed or dropped — unacceptable for a
/// 45-minute talk. We use `.other` as a neutral activity that suits both a talk
/// and general timing; gym presets could map to a more specific type later.
@MainActor
final class WorkoutKeepAlive: NSObject {
    #if os(watchOS)
    private let healthStore = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    #endif

    private var isActive = false

    /// Latest live heart rate (bpm), forwarded for finish detection.
    var onHeartRate: ((Double) -> Void)?

    /// Request HealthKit authorization up front (call once at launch is fine too).
    func requestAuthorization() {
        #if os(watchOS)
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let share: Set = [HKObjectType.workoutType()]
        var read: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let hr = HKObjectType.quantityType(forIdentifier: .heartRate) { read.insert(hr) }
        healthStore.requestAuthorization(toShare: share, read: read) { _, _ in }
        #endif
    }

    func startIfNeeded(kind: WorkoutKind = .functionalStrength) {
        #if os(watchOS)
        guard !isActive, HKHealthStore.isHealthDataAvailable() else { return }
        let config = HKWorkoutConfiguration()
        config.activityType = Self.hkType(kind)
        config.locationType = .indoor
        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: config)
            builder.delegate = self
            self.session = session
            self.builder = builder
            let start = Date()
            session.startActivity(with: start)
            builder.beginCollection(withStart: start) { _, _ in }
            isActive = true
        } catch {
            #if DEBUG
            print("WorkoutKeepAlive start failed: \(error)")
            #endif
        }
        #endif
    }

    func stop() {
        #if os(watchOS)
        guard isActive else { return }
        isActive = false
        session?.end()
        builder?.endCollection(withEnd: Date()) { [weak self] _, _ in
            // The completion runs off the main actor; hop back before touching
            // our main-actor-isolated builder/session.
            Task { @MainActor in self?.finishWorkout() }
        }
        #else
        isActive = false
        #endif
    }

    #if os(watchOS)
    private static func hkType(_ kind: WorkoutKind) -> HKWorkoutActivityType {
        switch kind {
        case .functionalStrength: return .functionalStrengthTraining
        case .traditionalStrength: return .traditionalStrengthTraining
        case .core: return .coreTraining
        case .hiit: return .highIntensityIntervalTraining
        case .cycling: return .cycling
        case .running: return .running
        case .walking: return .walking
        case .elliptical: return .elliptical
        case .rowing: return .rowing
        case .yoga: return .yoga
        case .other: return .other
        }
    }

    @MainActor
    private func finishWorkout() {
        builder?.finishWorkout { _, _ in }
        builder = nil
        session = nil
    }
    #endif
}

#if os(watchOS)
extension WorkoutKeepAlive: HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder,
                                    didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard let hrType = HKObjectType.quantityType(forIdentifier: .heartRate),
              collectedTypes.contains(hrType),
              let bpm = workoutBuilder.statistics(for: hrType)?
                .mostRecentQuantity()?.doubleValue(for: HKUnit(from: "count/min"))
        else { return }
        Task { @MainActor in self.onHeartRate?(bpm) }
    }

    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
}
#endif
