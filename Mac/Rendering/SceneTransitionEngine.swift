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
        let pairs = matchItems(from: t.from.items, to: t.to.items)
        let consumedFromIDs = Set(pairs.values.map(\.id))

        var items: [RenderItem] = []

        // Outgoing-only items: exit animation compressed into the window.
        // Draw them first (under everything arriving).
        for item in t.from.items where !consumedFromIDs.contains(item.id) {
            var out = item
            if out.entryAnimation.style == .none {
                out.transform.opacity *= (1 - p)          // fall back to fade
            } else {
                out.transform = out.entryAnimation.apply(progress: 1 - p, to: out.transform)
            }
            if out.transform.opacity > 0.001 { items.append(out) }
        }

        // Matched items: interpolate transform + corner radius; the incoming
        // scene's content/effects/blending win throughout so effect chains
        // don't pop mid-glide.
        // Iterate the incoming order so z-order lands where the new scene wants it.
        for item in t.to.items {
            if let from = pairs[item.id] {
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

    /// Which outgoing item each incoming item continues, keyed by the
    /// incoming item's id. Two passes:
    ///  1. Transition keys — hard identity (same camera, same guest, same
    ///     media file, same element id from a duplicated scene).
    ///  2. Proximity — leftover items of the same content class (text↔text,
    ///     shape↔shape, movie↔movie…) pair with the nearest unclaimed
    ///     sibling. This is what makes independently built scenes smart:
    ///     a lower-third text in both scenes stays put and swaps its words
    ///     instead of fading out and back in.
    private static func matchItems(from: [RenderItem],
                                   to: [RenderItem]) -> [UUID: RenderItem] {
        let fromByKey = Dictionary(from.map { ($0.transitionKey, $0) },
                                   uniquingKeysWith: { a, _ in a })
        var pairs: [UUID: RenderItem] = [:]
        var consumed = Set<UUID>()

        for item in to {
            if let match = fromByKey[item.transitionKey], !consumed.contains(match.id) {
                pairs[item.id] = match
                consumed.insert(match.id)
            }
        }

        var leftovers = from.filter { !consumed.contains($0.id) }
        for item in to where pairs[item.id] == nil {
            guard let cls = contentClass(item) else { continue }
            var bestIndex: Int?
            var bestDistance = Double.infinity
            for (index, candidate) in leftovers.enumerated()
            where contentClass(candidate) == cls {
                let dx = candidate.transform.center.x - item.transform.center.x
                let dy = candidate.transform.center.y - item.transform.center.y
                let distance = dx * dx + dy * dy
                if distance < bestDistance {
                    bestDistance = distance
                    bestIndex = index
                }
            }
            if let index = bestIndex {
                pairs[item.id] = leftovers.remove(at: index)
            }
        }
        return pairs
    }

    /// The class within which proximity pairing is allowed. Live sources are
    /// nil on purpose: two DIFFERENT cameras must never morph into each
    /// other — identity handled those in pass 1.
    private static func contentClass(_ item: RenderItem) -> String? {
        switch item.content {
        case .text: return "text"
        case .fill: return "shape"
        case .source(let key):
            switch key {
            case .image: return "image"
            case .movie, .scenePrimary: return nil
            case .web: return "web"
            default: return nil
            }
        }
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
