import Foundation
import CoreGraphics

/// Automatic scene-to-scene animation ("magic move").
///
/// Given the outgoing and incoming plans and a progress value, produces the
/// blended item list for one frame:
///  - Items whose `transitionKey` exists in BOTH scenes (the same camera, the
///    same guest tile, the same screen share) get their transforms
///    interpolated — they glide/resize to their new spots.
///  - Items only in the outgoing scene play their exit animation compressed
///    into the transition window.
///  - Items only in the incoming scene play their entry animation.
///  - `.dissolve` crossfades everything; `.cut` never reaches this engine.
enum SceneTransitionEngine {
    struct Transition: Sendable {
        var from: RenderPlan
        var to: RenderPlan
        var style: SceneTransitionStyle
        var startSeconds: Double
        var duration: TimeInterval

        func progress(at now: Double) -> Double {
            guard duration > 0 else { return 1 }
            return min(1, max(0, (now - startSeconds) / duration))
        }
    }

    /// Blended plan for one frame of the transition.
    static func blend(_ transition: Transition, at now: Double) -> RenderPlan {
        let raw = transition.progress(at: now)
        // Ease the whole transition; matched-move looks best with easeInOut.
        let p = EntryAnimation.Curve.easeInOut.value(raw)

        switch transition.style {
        case .cut:
            return transition.to
        case .dissolve:
            return dissolve(transition, progress: p)
        case .magicMove:
            return magicMove(transition, progress: p)
        }
    }

    private static func dissolve(_ t: Transition, progress p: Double) -> RenderPlan {
        var items: [RenderItem] = []
        for var item in t.from.items {
            item.transform.opacity *= (1 - p)
            items.append(item)
        }
        for var item in t.to.items {
            item.transform.opacity *= p
            items.append(item)
        }
        var plan = t.to
        plan.items = items
        return plan
    }

    private static func magicMove(_ t: Transition, progress p: Double) -> RenderPlan {
        let fromByKey = Dictionary(t.from.items.map { ($0.transitionKey, $0) },
                                   uniquingKeysWith: { a, _ in a })
        let toByKey = Dictionary(t.to.items.map { ($0.transitionKey, $0) },
                                 uniquingKeysWith: { a, _ in a })

        var items: [RenderItem] = []

        // Outgoing-only items: exit animation compressed into the window.
        // Draw them first (under everything arriving).
        for item in t.from.items where toByKey[item.transitionKey] == nil {
            var out = item
            if out.entryAnimation.style == .none {
                out.transform.opacity *= (1 - p)          // fall back to fade
            } else {
                out.transform = out.entryAnimation.apply(progress: 1 - p, to: out.transform)
            }
            if out.transform.opacity > 0.001 { items.append(out) }
        }

        // Items in both scenes: interpolate transform + corner radius; the
        // incoming scene's content/effects/blending win throughout so effect
        // chains don't pop mid-glide.
        // Iterate the incoming order so z-order lands where the new scene wants it.
        for item in t.to.items {
            if let from = fromByKey[item.transitionKey] {
                var moved = item
                moved.transform = ElementTransform.lerp(from.transform, item.transform, p)
                moved.cornerRadius = from.cornerRadius + (item.cornerRadius - from.cornerRadius) * p
                items.append(moved)
            } else {
                // Incoming-only: entry animation across the window.
                var inItem = item
                if inItem.entryAnimation.style == .none {
                    inItem.transform.opacity *= p
                } else {
                    inItem.transform = inItem.entryAnimation.apply(progress: p, to: inItem.transform)
                }
                items.append(inItem)
            }
        }

        var plan = t.to
        plan.items = items
        return plan
    }

    /// Sources that must be running during the transition: the union of both
    /// scenes' source keys (the registry keeps both alive until it ends).
    static func activeSourceKeys(_ t: Transition) -> Set<SourceKey> {
        var keys = Set<SourceKey>()
        for item in t.from.items + t.to.items {
            if case .source(let key) = item.content { keys.insert(key) }
        }
        return keys
    }
}
