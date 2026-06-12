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

    /// Request HealthKit authorization up front (call once at launch is fine too).
    func requestAuthorization() {
        #if os(watchOS)
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let types: Set = [HKObjectType.workoutType()]
        healthStore.requestAuthorization(toShare: types, read: types) { _, _ in }
        #endif
    }

    func startIfNeeded() {
        #if os(watchOS)
        guard !isActive, HKHealthStore.isHealthDataAvailable() else { return }
        let config = HKWorkoutConfiguration()
        config.activityType = .other
        config.locationType = .indoor
        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: config)
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
        let end = Date()
        session?.end()
        builder?.endCollection(withEnd: end) { [weak self] _, _ in
            self?.builder?.finishWorkout { _, _ in }
        }
        session = nil
        builder = nil
        #endif
        isActive = false
    }
}
