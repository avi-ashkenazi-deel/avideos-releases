import XCTest
@testable import AVideosStudio

/// Pins down the entry-animation catalogue. The invariants matter more than
/// any individual curve: every style must land **exactly** on the resting
/// transform at progress 1 and be invisible at 0, or elements drift out of
/// position and flash when shown and hidden. Exit is the same evaluation run
/// backwards, so those two endpoints are the whole contract.
final class EntryAnimationTests: XCTestCase {

    private let resting = ElementTransform(center: CGPoint(x: 0.4, y: 0.6),
                                          size: CGSize(width: 0.5, height: 0.25),
                                          rotation: 0.1,
                                          opacity: 0.9)

    private var animatedStyles: [EntryAnimation.Style] {
        EntryAnimation.Style.allCases.filter { $0 != .none }
    }

    // MARK: Catalogue shape

    func testCatalogueHasTwentyAnimationsPlusNone() {
        XCTAssertEqual(animatedStyles.count, 20)
        XCTAssertTrue(EntryAnimation.Style.allCases.contains(.none))
        XCTAssertEqual(EntryAnimation.Style.allCases.count, 21)
    }

    func testEveryStyleHasADistinctDisplayName() {
        let names = EntryAnimation.Style.allCases.map(\.displayName)
        XCTAssertEqual(Set(names).count, names.count)
        XCTAssertFalse(names.contains { $0.isEmpty })
    }

    func testEveryStyleBelongsToExactlyOneCategoryAndEveryCategoryIsPopulated() {
        for category in EntryAnimation.Style.Category.allCases {
            XCTAssertFalse(EntryAnimation.Style.styles(in: category).isEmpty,
                           "\(category.rawValue) has no styles, so the picker shows an empty group")
        }
        // Partition: the categories together cover every style, once each.
        let grouped = EntryAnimation.Style.Category.allCases
            .flatMap { EntryAnimation.Style.styles(in: $0) }
        XCTAssertEqual(grouped.count, EntryAnimation.Style.allCases.count)
        XCTAssertEqual(Set(grouped), Set(EntryAnimation.Style.allCases))
    }

    func testRawValuesAreStableForPersistence() {
        // Renaming a raw value silently breaks saved projects.
        XCTAssertEqual(EntryAnimation.Style.fade.rawValue, "fade")
        XCTAssertEqual(EntryAnimation.Style.slideFromLeft.rawValue, "slideFromLeft")
        XCTAssertEqual(EntryAnimation.Style.scaleUp.rawValue, "scaleUp")
        XCTAssertEqual(EntryAnimation.Style.pop.rawValue, "pop")
    }

    func testSuggestedDurationsAreUsable() {
        for style in animatedStyles {
            XCTAssertGreaterThanOrEqual(style.suggestedDuration, 0.15, "\(style)")
            XCTAssertLessThanOrEqual(style.suggestedDuration, 1.2, "\(style)")
        }
        XCTAssertEqual(EntryAnimation.Style.none.suggestedDuration, 0)
        // A bounce needs longer than a fade or it reads as a glitch.
        XCTAssertGreaterThan(EntryAnimation.Style.bounceIn.suggestedDuration,
                             EntryAnimation.Style.fade.suggestedDuration)
    }

    func testStyledHelperAdoptsTheSuggestedDuration() {
        let animation = EntryAnimation.styled(.bounceIn)
        XCTAssertEqual(animation.style, .bounceIn)
        XCTAssertEqual(animation.duration, EntryAnimation.Style.bounceIn.suggestedDuration,
                       accuracy: 1e-9)
    }

    // MARK: The two endpoints — the core contract

    func testEveryStyleLandsExactlyOnRestAtProgressOne() {
        for style in EntryAnimation.Style.allCases {
            for curve in EntryAnimation.Curve.allCases {
                let animation = EntryAnimation(style: style, duration: 0.4, curve: curve)
                let final = animation.apply(progress: 1, to: resting)
                assertEqual(final, resting,
                            "\(style) with \(curve) must finish exactly at rest")
            }
        }
    }

    func testEveryStyleIsInvisibleAtProgressZero() {
        // "Invisible" means nothing is drawn — either fully transparent, or
        // collapsed to zero area. Wipes deliberately keep full opacity and
        // reveal by geometry instead, and that is just as invisible at 0.
        for style in EntryAnimation.Style.allCases {
            let animation = EntryAnimation(style: style, duration: 0.4, curve: .easeOut)
            let start = animation.apply(progress: 0, to: resting)
            XCTAssertTrue(isInvisible(start),
                          "\(style) must draw nothing at progress 0, or it pops in")
        }
    }

    func testProgressIsClampedOutsideZeroToOne() {
        for style in EntryAnimation.Style.allCases {
            let animation = EntryAnimation(style: style, duration: 0.4, curve: .easeOut)
            assertEqual(animation.apply(progress: 1.5, to: resting), resting,
                        "\(style) beyond 1")
            XCTAssertTrue(isInvisible(animation.apply(progress: -0.5, to: resting)),
                          "\(style) below 0")
        }
    }

    /// Wipes reveal by geometry; everything else fades. Either counts.
    private func isInvisible(_ t: ElementTransform) -> Bool {
        t.opacity <= 1e-9 || t.size.width <= 1e-9 || t.size.height <= 1e-9
    }

    // MARK: Nothing degenerate mid-flight

    func testNoStyleProducesNonFiniteOrNegativeGeometry() {
        for style in EntryAnimation.Style.allCases {
            let animation = EntryAnimation(style: style, duration: 0.4, curve: .easeOut)
            for step in 0...40 {
                let t = animation.apply(progress: Double(step) / 40, to: resting)
                XCTAssertTrue(t.center.x.isFinite && t.center.y.isFinite, "\(style)")
                XCTAssertTrue(t.size.width.isFinite && t.size.height.isFinite, "\(style)")
                XCTAssertTrue(t.rotation.isFinite && t.opacity.isFinite, "\(style)")
                XCTAssertGreaterThanOrEqual(t.size.width, 0, "\(style) went negative-width")
                XCTAssertGreaterThanOrEqual(t.size.height, 0, "\(style) went negative-height")
                XCTAssertGreaterThanOrEqual(t.opacity, 0, "\(style)")
                XCTAssertLessThanOrEqual(t.opacity, resting.opacity + 1e-9,
                                         "\(style) exceeded the element's own opacity")
            }
        }
    }

    func testOpacityNeverDecreasesAsTheEntryProgresses() {
        // Entry should reveal monotonically; a dip mid-flight reads as a flicker.
        for style in animatedStyles {
            let animation = EntryAnimation(style: style, duration: 0.4, curve: .linear)
            var previous = -1.0
            for step in 0...40 {
                let opacity = animation.apply(progress: Double(step) / 40, to: resting).opacity
                XCTAssertGreaterThanOrEqual(opacity, previous - 1e-9,
                                            "\(style) dipped in opacity at step \(step)")
                previous = opacity
            }
        }
    }

    // MARK: Direction and character, per family

    func testSlidesStartOffCanvasOnTheExpectedSide() {
        let cases: [(EntryAnimation.Style, (ElementTransform) -> Bool)] = [
            (.slideFromLeft, { $0.center.x < 0 }),
            (.slideFromRight, { $0.center.x > 1 }),
            (.slideFromTop, { $0.center.y < 0 }),
            (.slideFromBottom, { $0.center.y > 1 }),
        ]
        for (style, isOffCanvas) in cases {
            let start = EntryAnimation(style: style, duration: 0.4, curve: .linear)
                .apply(progress: 0, to: resting)
            XCTAssertTrue(isOffCanvas(start), "\(style) should begin outside the frame")
        }
    }

    func testDriftsStayInsideTheFrame() {
        // The whole point of a drift is that it doesn't fly in from off-screen.
        for style in EntryAnimation.Style.styles(in: .drift) {
            let start = EntryAnimation(style: style, duration: 0.4, curve: .linear)
                .apply(progress: 0, to: resting)
            XCTAssertGreaterThan(start.center.x, 0, "\(style)")
            XCTAssertLessThan(start.center.x, 1, "\(style)")
            XCTAssertGreaterThan(start.center.y, 0, "\(style)")
            XCTAssertLessThan(start.center.y, 1, "\(style)")
            XCTAssertNotEqual(start.center, resting.center, "\(style) has to move at all")
        }
    }

    func testRiseUpStartsBelowAndSettleDownStartsAbove() {
        // y grows downward in this coordinate space.
        let rise = EntryAnimation(style: .riseUp, duration: 0.4, curve: .linear)
            .apply(progress: 0, to: resting)
        XCTAssertGreaterThan(rise.center.y, resting.center.y, "Rise Up starts lower")

        let settle = EntryAnimation(style: .settleDown, duration: 0.4, curve: .linear)
            .apply(progress: 0, to: resting)
        XCTAssertLessThan(settle.center.y, resting.center.y, "Settle Down starts higher")
    }

    func testScaleUpGrowsAndScaleDownShrinks() {
        let up = EntryAnimation(style: .scaleUp, duration: 0.4, curve: .linear)
            .apply(progress: 0.01, to: resting)
        XCTAssertLessThan(up.size.width, resting.size.width, "Scale Up starts small")

        let down = EntryAnimation(style: .scaleDown, duration: 0.4, curve: .linear)
            .apply(progress: 0.01, to: resting)
        XCTAssertGreaterThan(down.size.width, resting.size.width, "Scale Down starts large")
    }

    func testOvershootStylesActuallyPassTheTarget() {
        // If they never exceed 1 they are just eases with extra steps.
        for style in [EntryAnimation.Style.pop, .flipHorizontal, .flipVertical] {
            let animation = EntryAnimation(style: style, duration: 0.4, curve: .linear)
            let peak = (0...40).map { step -> Double in
                let t = animation.apply(progress: Double(step) / 40, to: resting)
                return max(t.size.width / resting.size.width,
                           t.size.height / resting.size.height)
            }.max() ?? 0
            XCTAssertGreaterThan(peak, 1.01, "\(style) should overshoot before settling")
            XCTAssertLessThan(peak, 1.25, "\(style) overshoot should stay tasteful")
        }
    }

    func testSpringUpOvershootsItsTargetPosition() {
        let animation = EntryAnimation(style: .springUp, duration: 0.6, curve: .linear)
        // It starts below and should momentarily rise past the resting y.
        let minimumY = (0...60).map {
            animation.apply(progress: Double($0) / 60, to: resting).center.y
        }.min() ?? .infinity
        XCTAssertLessThan(minimumY, resting.center.y - 1e-6,
                          "Spring Up should pass its mark then settle back")
    }

    func testBounceInBouncesMoreThanOnce() {
        let animation = EntryAnimation(style: .bounceIn, duration: 0.75, curve: .linear)
        let widths = (0...80).map {
            animation.apply(progress: Double($0) / 80, to: resting).size.width
        }
        // Count direction reversals: a real bounce reverses several times.
        var reversals = 0
        for i in 1..<(widths.count - 1) {
            let rising = widths[i] > widths[i - 1]
            let nextRising = widths[i + 1] > widths[i]
            if rising != nextRising { reversals += 1 }
        }
        XCTAssertGreaterThanOrEqual(reversals, 2, "Bounce In should visibly bounce")
    }

    func testWipesGrowOneAxisOnlyAndKeepFullOpacity() {
        let horizontal = EntryAnimation(style: .wipeFromCenterH, duration: 0.35, curve: .linear)
            .apply(progress: 0.5, to: resting)
        XCTAssertEqual(horizontal.size.height, resting.size.height, accuracy: 1e-9,
                       "a horizontal wipe must not change height")
        XCTAssertLessThan(horizontal.size.width, resting.size.width)
        XCTAssertEqual(horizontal.opacity, resting.opacity, accuracy: 1e-9,
                       "a wipe reveals by geometry, not by fading")

        let vertical = EntryAnimation(style: .wipeFromCenterV, duration: 0.35, curve: .linear)
            .apply(progress: 0.5, to: resting)
        XCTAssertEqual(vertical.size.width, resting.size.width, accuracy: 1e-9)
        XCTAssertLessThan(vertical.size.height, resting.size.height)
    }

    func testRotationStylesReturnToTheRestingAngle() {
        for style in EntryAnimation.Style.styles(in: .rotate) {
            let animation = EntryAnimation(style: style, duration: 0.5, curve: .linear)
            let mid = animation.apply(progress: 0.35, to: resting)
            XCTAssertNotEqual(mid.rotation, resting.rotation,
                              "\(style) should actually rotate")
            XCTAssertEqual(animation.apply(progress: 1, to: resting).rotation,
                           resting.rotation, accuracy: 1e-9,
                           "\(style) must straighten out exactly")
            // Tasteful means degrees, not turns.
            let peak = (0...50).map {
                abs(animation.apply(progress: Double($0) / 50, to: resting).rotation
                    - resting.rotation)
            }.max() ?? 0
            XCTAssertLessThan(peak, 0.4, "\(style) rotates too far to be tasteful")
        }
    }

    func testSwingInOscillates() {
        let animation = EntryAnimation(style: .swingIn, duration: 0.6, curve: .linear)
        let offsets = (0...60).map {
            animation.apply(progress: Double($0) / 60, to: resting).rotation - resting.rotation
        }
        XCTAssertTrue(offsets.contains { $0 > 1e-6 }, "should swing one way")
        XCTAssertTrue(offsets.contains { $0 < -1e-6 }, "and back the other")
    }

    // MARK: Curve interaction

    func testStylesWithOwnTimingIgnoreTheCurve() {
        for style in animatedStyles where style.definesOwnTiming {
            let linear = EntryAnimation(style: style, duration: 0.5, curve: .linear)
                .apply(progress: 0.4, to: resting)
            let eased = EntryAnimation(style: style, duration: 0.5, curve: .easeInOut)
                .apply(progress: 0.4, to: resting)
            assertEqual(linear, eased,
                        "\(style) declares its own timing, so the curve must not alter it")
        }
    }

    func testStylesWithoutOwnTimingRespondToTheCurve() {
        for style in animatedStyles where !style.definesOwnTiming {
            let linear = EntryAnimation(style: style, duration: 0.5, curve: .linear)
                .apply(progress: 0.4, to: resting)
            let eased = EntryAnimation(style: style, duration: 0.5, curve: .easeIn)
                .apply(progress: 0.4, to: resting)
            let differs = abs(linear.opacity - eased.opacity) > 1e-9
                || abs(linear.center.x - eased.center.x) > 1e-9
                || abs(linear.center.y - eased.center.y) > 1e-9
                || abs(linear.size.width - eased.size.width) > 1e-9
                || abs(linear.rotation - eased.rotation) > 1e-9
            XCTAssertTrue(differs, "\(style) should be shaped by the curve setting")
        }
    }

    // MARK: Persistence

    func testAnimationRoundTrips() throws {
        for style in EntryAnimation.Style.allCases {
            let animation = EntryAnimation.styled(style, curve: .easeInOut)
            let data = try JSONEncoder().encode(animation)
            XCTAssertEqual(try JSONDecoder().decode(EntryAnimation.self, from: data),
                           animation, "\(style)")
        }
    }

    // MARK: Helpers

    private func assertEqual(_ a: ElementTransform,
                             _ b: ElementTransform,
                             _ message: String,
                             file: StaticString = #filePath,
                             line: UInt = #line) {
        XCTAssertEqual(a.center.x, b.center.x, accuracy: 1e-9, message, file: file, line: line)
        XCTAssertEqual(a.center.y, b.center.y, accuracy: 1e-9, message, file: file, line: line)
        XCTAssertEqual(a.size.width, b.size.width, accuracy: 1e-9, message, file: file, line: line)
        XCTAssertEqual(a.size.height, b.size.height, accuracy: 1e-9, message, file: file, line: line)
        XCTAssertEqual(a.rotation, b.rotation, accuracy: 1e-9, message, file: file, line: line)
        XCTAssertEqual(a.opacity, b.opacity, accuracy: 1e-9, message, file: file, line: line)
    }
}
