import XCTest
@testable import Streamit

/// Pins down source framing: the sampling-window arithmetic the shader uses to
/// fit a source into a differently-shaped canvas, and the plan-level expansion
/// of `.blurredBackdrop` into a backdrop plus a foreground item.
///
/// The window maths is reimplemented here from the documented contract rather
/// than called from the shader (MSL can't be unit-tested), so these tests are
/// the specification: if the shader and this file disagree, one of them is
/// wrong and the fix belongs wherever the contract says.
final class SourceFramingTests: XCTestCase {

    /// The sampled window in source-uv units, per `framedUV` in Composite.metal.
    /// width/height < 1 means we sample a sub-rect (cropping); > 1 means we
    /// sample past the edges (leaving empty space beside the content).
    private func window(fit: SourceFit,
                        contentAspect: Double,
                        itemAspect: Double) -> CGSize {
        var size = CGSize(width: 1, height: 1)
        switch fit {
        case .stretch:
            return size
        case .fill:
            if contentAspect > itemAspect {
                size.width = itemAspect / contentAspect
            } else {
                size.height = contentAspect / itemAspect
            }
        case .fit, .blurredBackdrop:
            if contentAspect > itemAspect {
                size.height = contentAspect / itemAspect
            } else {
                size.width = itemAspect / contentAspect
            }
        }
        return size
    }

    private let sixteenNine = 16.0 / 9.0
    private let nineSixteen = 9.0 / 16.0
    private let fourThree = 4.0 / 3.0

    // MARK: Matching aspect

    func testMatchingAspectNeedsNoAdjustmentInAnyMode() {
        for fit in SourceFit.allCases {
            let w = window(fit: fit, contentAspect: sixteenNine, itemAspect: sixteenNine)
            XCTAssertEqual(w.width, 1, accuracy: 1e-9, "\(fit)")
            XCTAssertEqual(w.height, 1, accuracy: 1e-9, "\(fit)")
        }
    }

    // MARK: Contain (fit)

    func testFitOfA4x3WindowInto16x9LeavesSpaceLeftAndRight() {
        // Content is narrower than the canvas, so the sampled window has to
        // extend horizontally past the source — that overhang is the empty
        // space beside the picture.
        let w = window(fit: .fit, contentAspect: fourThree, itemAspect: sixteenNine)
        XCTAssertEqual(w.height, 1, accuracy: 1e-9, "full height is used")
        XCTAssertGreaterThan(w.width, 1, "space appears on the sides, not top/bottom")
        XCTAssertEqual(w.width, sixteenNine / fourThree, accuracy: 1e-9)
    }

    func testFitOfA16x9SourceIntoVerticalLeavesSpaceAboveAndBelow() {
        let w = window(fit: .fit, contentAspect: sixteenNine, itemAspect: nineSixteen)
        XCTAssertEqual(w.width, 1, accuracy: 1e-9, "full width is used")
        XCTAssertGreaterThan(w.height, 1, "space appears above and below")
        XCTAssertEqual(w.height, sixteenNine / nineSixteen, accuracy: 1e-9)
    }

    func testFitNeverCropsTheSource() {
        for content in [fourThree, sixteenNine, nineSixteen, 1.0, 2.35] {
            for item in [sixteenNine, nineSixteen, 1.0] {
                let w = window(fit: .fit, contentAspect: content, itemAspect: item)
                XCTAssertGreaterThanOrEqual(w.width, 1 - 1e-9,
                                            "content \(content) in item \(item)")
                XCTAssertGreaterThanOrEqual(w.height, 1 - 1e-9,
                                            "content \(content) in item \(item)")
            }
        }
    }

    // MARK: Cover (fill)

    func testFillOfA4x3SourceInto16x9CropsTopAndBottom() {
        // Content is narrower, so to cover we use the full width and crop
        // vertically.
        let w = window(fit: .fill, contentAspect: fourThree, itemAspect: sixteenNine)
        XCTAssertEqual(w.width, 1, accuracy: 1e-9)
        XCTAssertLessThan(w.height, 1, "the top and bottom are cropped away")
        XCTAssertEqual(w.height, fourThree / sixteenNine, accuracy: 1e-9)
    }

    func testFillOfA16x9SourceIntoVerticalCropsTheSides() {
        let w = window(fit: .fill, contentAspect: sixteenNine, itemAspect: nineSixteen)
        XCTAssertEqual(w.height, 1, accuracy: 1e-9)
        XCTAssertLessThan(w.width, 1, "the sides are cropped away")
        XCTAssertEqual(w.width, nineSixteen / sixteenNine, accuracy: 1e-9)
    }

    func testFillNeverLeavesEmptySpace() {
        for content in [fourThree, sixteenNine, nineSixteen, 1.0, 2.35] {
            for item in [sixteenNine, nineSixteen, 1.0] {
                let w = window(fit: .fill, contentAspect: content, itemAspect: item)
                XCTAssertLessThanOrEqual(w.width, 1 + 1e-9)
                XCTAssertLessThanOrEqual(w.height, 1 + 1e-9)
            }
        }
    }

    func testFitAndFillAreReciprocalOnTheAdjustedAxis() {
        let fitW = window(fit: .fit, contentAspect: fourThree, itemAspect: sixteenNine)
        let fillW = window(fit: .fill, contentAspect: fourThree, itemAspect: sixteenNine)
        // Fit grows the window horizontally by exactly the factor fill shrinks
        // it vertically.
        XCTAssertEqual(fitW.width, 1 / fillW.height, accuracy: 1e-9)
    }

    // MARK: Zoom

    func testZoomingInEventuallyRemovesTheEmptySpace() {
        // A 4:3 source fitted into 16:9 has space at the sides; zooming by the
        // window's own width is exactly enough to fill the frame.
        let w = window(fit: .fit, contentAspect: fourThree, itemAspect: sixteenNine)
        let zoomToFill = w.width
        // After zooming, the effective window is window/zoom — at most 1 on
        // both axes, i.e. no overhang left.
        XCTAssertEqual(w.width / zoomToFill, 1, accuracy: 1e-9)
        XCTAssertLessThanOrEqual(w.height / zoomToFill, 1 + 1e-9)
    }

    func testZoomIsClampedToASaneRange() {
        var presentation = SourcePresentation(fit: .fit, zoom: 500)
        XCTAssertLessThanOrEqual(presentation.sanitized.zoom, 8)
        presentation.zoom = -3
        XCTAssertGreaterThanOrEqual(presentation.sanitized.zoom, 0.2)
    }

    func testPanAndBlurAreClamped() {
        let presentation = SourcePresentation(fit: .blurredBackdrop,
                                             zoom: 1,
                                             pan: CGPoint(x: 9, y: -9),
                                             backdropBlur: 5,
                                             backdropZoom: 99)
        let clean = presentation.sanitized
        XCTAssertLessThanOrEqual(clean.pan.x, 1)
        XCTAssertGreaterThanOrEqual(clean.pan.y, -1)
        XCTAssertLessThanOrEqual(clean.backdropBlur, 1)
        XCTAssertLessThanOrEqual(clean.backdropZoom, 3)
        XCTAssertGreaterThanOrEqual(clean.backdropZoom, 1)
    }

    // MARK: Defaults and persistence

    func testDefaultFitIsContain() {
        // Stretching is never the default: it distorts faces and text.
        XCTAssertEqual(SourcePresentation.default.fit, .fit)
        XCTAssertEqual(SourcePresentation.default.zoom, 1, accuracy: 1e-9)
        XCTAssertEqual(SceneModel(name: "S", kind: .camera(CameraSceneConfig()))
                        .primaryPresentation.fit, .fit)
    }

    func testPresentationRoundTrips() throws {
        let presentation = SourcePresentation(fit: .blurredBackdrop,
                                              zoom: 1.4,
                                              pan: CGPoint(x: 0.2, y: -0.1),
                                              backdropBlur: 0.8,
                                              backdropZoom: 1.2)
        let data = try JSONEncoder().encode(presentation)
        XCTAssertEqual(try JSONDecoder().decode(SourcePresentation.self, from: data),
                       presentation)
    }

    func testSceneDecodesWithoutAFramingKey() throws {
        // Projects saved before framing existed must still load. Built by
        // stripping the key from real encoded output rather than hand-writing
        // JSON, so the fixture can't drift from SceneKind's encoding.
        let scene = SceneModel(name: "Old Scene", kind: .camera(CameraSceneConfig()))
        let encoded = try JSONEncoder().encode(scene)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNotNil(object["primaryPresentation"], "the key should be written today")
        object.removeValue(forKey: "primaryPresentation")

        let legacy = try JSONSerialization.data(withJSONObject: object)
        let decoded = try JSONDecoder().decode(SceneModel.self, from: legacy)
        XCTAssertEqual(decoded.primaryPresentation.fit, .fit,
                       "a missing framing key must default, not fail the load")
        XCTAssertEqual(decoded.name, "Old Scene")
    }

    // MARK: Plan expansion

    func testBlurredBackdropCompilesToTwoItems() {
        let scene = makeScreenScene(fit: .blurredBackdrop)
        let project = makeProject(scene: scene)
        let plan = RenderPlanCompiler.compile(project: project, scene: scene,
                                              guests: [], elementAnimations: [:])
        let sourceItems = plan.items.filter { isSource($0) }
        XCTAssertEqual(sourceItems.count, 2, "a blurred backdrop plus the sharp copy")

        let backdrop = sourceItems.first { $0.isBackdrop }
        let foreground = sourceItems.first { !$0.isBackdrop }
        XCTAssertNotNil(backdrop)
        XCTAssertNotNil(foreground)

        // Backdrop is drawn first (underneath) and covers the frame.
        XCTAssertTrue(sourceItems.first?.isBackdrop ?? false,
                      "the backdrop has to be behind the sharp copy")
        XCTAssertEqual(backdrop?.presentation.fit, .fill)
        XCTAssertGreaterThan(backdrop?.presentation.zoom ?? 0, 1,
                             "pushed past the edges so its borders aren't visible")
        XCTAssertEqual(foreground?.presentation.fit, .fit)
    }

    func testBackdropCarriesNoEffectsAndNoManualPan() {
        var scene = makeScreenScene(fit: .blurredBackdrop)
        scene.primaryEffects = EffectChain(effects: [.contrast(1.4)])
        scene.primaryPresentation.pan = CGPoint(x: 0.3, y: 0.3)
        let plan = RenderPlanCompiler.compile(project: makeProject(scene: scene), scene: scene,
                                              guests: [], elementAnimations: [:])
        let backdrop = plan.items.first { $0.isBackdrop }
        XCTAssertEqual(backdrop?.effects.effects.count, 0,
                       "effects belong on the sharp copy only")
        XCTAssertEqual(backdrop?.presentation.pan.x ?? -1, 0, accuracy: 1e-9,
                       "the backdrop stays centred however the foreground is panned")
    }

    func testBackdropAndForegroundHaveDistinctIdentities() {
        let scene = makeScreenScene(fit: .blurredBackdrop)
        let plan = RenderPlanCompiler.compile(project: makeProject(scene: scene), scene: scene,
                                              guests: [], elementAnimations: [:])
        let ids = plan.items.filter { isSource($0) }.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count,
                       "ids must differ or animation state and effect caches collide")
        let keys = plan.items.filter { isSource($0) }.map(\.transitionKey)
        XCTAssertEqual(Set(keys).count, keys.count,
                       "transition keys must differ or magic move matches the wrong one")
    }

    func testBackdropIDIsStableAndDistinct() {
        let sceneID = UUID()
        XCTAssertEqual(RenderPlanCompiler.backdropID(for: sceneID),
                       RenderPlanCompiler.backdropID(for: sceneID),
                       "must be stable across recompiles")
        XCTAssertNotEqual(RenderPlanCompiler.backdropID(for: sceneID), sceneID)
        XCTAssertNotEqual(RenderPlanCompiler.backdropID(for: sceneID),
                          RenderPlanCompiler.backdropID(for: UUID()))
    }

    func testOtherFitsCompileToASingleItem() {
        for fit in [SourceFit.fit, .fill, .stretch] {
            let scene = makeScreenScene(fit: fit)
            let plan = RenderPlanCompiler.compile(project: makeProject(scene: scene), scene: scene,
                                                  guests: [], elementAnimations: [:])
            let sourceItems = plan.items.filter { isSource($0) }
            XCTAssertEqual(sourceItems.count, 1, "\(fit) needs only one pass")
            XCTAssertEqual(sourceItems.first?.presentation.fit, fit)
            XCTAssertFalse(sourceItems.first?.isBackdrop ?? true)
        }
    }

    // MARK: Helpers

    private func isSource(_ item: RenderItem) -> Bool {
        if case .source = item.content { return true }
        return false
    }

    private func makeScreenScene(fit: SourceFit) -> SceneModel {
        var scene = SceneModel(name: "Screen",
                               kind: .screenShare(ScreenSceneConfig(target: .display(displayID: 1))))
        scene.primaryPresentation = SourcePresentation(fit: fit)
        return scene
    }

    private func makeProject(scene: SceneModel) -> Project {
        var project = Project(name: "Framing")
        project.scenes = [scene]
        project.activeSceneID = scene.id
        return project
    }
}
