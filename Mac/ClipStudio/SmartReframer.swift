import Foundation
import CoreGraphics

/// AI reframe/crop to any aspect ratio (our ReframeAnything): computes an
/// animated crop path per video track from the SceneIndex — subject face
/// centered with rule-of-thirds headroom, keyframes smoothed with a deadband
/// + critically-damped spring so the crop never jitters or drifts, and HARD
/// CUTS on speaker changes (pans between people look amateur).
///
/// Manual keyframes always win over AI ones.
struct CropKeyframe: Codable, Equatable {
    var time: Double
    /// Normalized crop rect (0…1 in source space).
    var rect: CGRect
    var isManual: Bool
}

enum SmartReframer {
    struct Config {
        /// Target aspect (width/height): 9:16 = 0.5625, 1:1, 4:5 = 0.8, 16:9.
        var targetAspect: Double
        /// Face-center deadband: movements smaller than this (normalized)
        /// don't move the crop at all.
        var deadband: Double = 0.06
        /// Spring smoothing factor per sample (critically damped feel).
        var smoothing: Double = 0.12
        /// Rule-of-thirds: eyes sit at 1/3 from the top of the crop.
        var headroom: Double = 1.0 / 3.0
    }

    /// Crop path for one video track. `sourceAspect` = source width/height.
    static func cropPath(faces: [SceneIndex.FaceSample],
                         sourceAspect: Double,
                         config: Config,
                         manualKeyframes: [CropKeyframe] = []) -> [CropKeyframe] {
        // Crop size in normalized source coords for the target aspect.
        let cropSize = normalizedCropSize(sourceAspect: sourceAspect, targetAspect: config.targetAspect)

        guard !faces.isEmpty else {
            // No face data: static center crop.
            return [CropKeyframe(time: 0, rect: centeredRect(size: cropSize, cx: 0.5, cy: 0.5), isManual: false)]
        }

        var keyframes: [CropKeyframe] = []
        var smoothedCX = faces[0].box.midX
        var smoothedCY = faces[0].box.midY

        for sample in faces {
            let faceCX = sample.box.midX
            // Eyes ~40% into the face box from the top.
            let eyeY = sample.box.minY + sample.box.height * 0.4

            // Deadband: ignore micro-movement.
            if abs(Double(faceCX) - Double(smoothedCX)) > config.deadband {
                smoothedCX += (faceCX - smoothedCX) * config.smoothing
            }
            if abs(Double(eyeY) - Double(smoothedCY)) > config.deadband {
                smoothedCY += (eyeY - smoothedCY) * config.smoothing
            }

            // Position the crop so the eyes land at `headroom` from its top.
            let cy = smoothedCY - CGFloat(config.headroom) * cropSize.height + cropSize.height / 2
            keyframes.append(CropKeyframe(time: sample.time,
                                          rect: centeredRect(size: cropSize,
                                                             cx: smoothedCX,
                                                             cy: cy),
                                          isManual: false))
        }

        // Manual keyframes replace AI keyframes in their neighborhood (±0.5s).
        guard !manualKeyframes.isEmpty else { return keyframes }
        var merged = keyframes.filter { auto in
            !manualKeyframes.contains { abs($0.time - auto.time) < 0.5 }
        }
        merged.append(contentsOf: manualKeyframes)
        return merged.sorted { $0.time < $1.time }
    }

    /// Interpolated crop rect at a time (step at hard cuts, lerp otherwise).
    static func rect(at time: Double, in path: [CropKeyframe]) -> CGRect {
        guard let first = path.first else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
        guard time > first.time else { return first.rect }
        guard let last = path.last, time < last.time else { return path.last?.rect ?? first.rect }

        for i in 0..<(path.count - 1) {
            let a = path[i]
            let b = path[i + 1]
            guard time >= a.time, time < b.time else { continue }
            // Large jumps between consecutive keyframes = speaker change → cut.
            let jump = hypot(b.rect.midX - a.rect.midX, b.rect.midY - a.rect.midY)
            if jump > 0.25 { return a.rect }
            let t = CGFloat((time - a.time) / max(b.time - a.time, 0.001))
            return CGRect(x: a.rect.origin.x + (b.rect.origin.x - a.rect.origin.x) * t,
                          y: a.rect.origin.y + (b.rect.origin.y - a.rect.origin.y) * t,
                          width: a.rect.width,
                          height: a.rect.height)
        }
        return first.rect
    }

    // MARK: - Geometry

    static func normalizedCropSize(sourceAspect: Double, targetAspect: Double) -> CGSize {
        if targetAspect < sourceAspect {
            // Narrower than source: full height, cropped width.
            return CGSize(width: CGFloat(targetAspect / sourceAspect), height: 1)
        } else {
            // Wider than source: full width, cropped height.
            return CGSize(width: 1, height: CGFloat(sourceAspect / targetAspect))
        }
    }

    private static func centeredRect(size: CGSize, cx: CGFloat, cy: CGFloat) -> CGRect {
        var rect = CGRect(x: cx - size.width / 2,
                          y: cy - size.height / 2,
                          width: size.width,
                          height: size.height)
        // Clamp inside the source frame.
        rect.origin.x = max(0, min(rect.origin.x, 1 - rect.width))
        rect.origin.y = max(0, min(rect.origin.y, 1 - rect.height))
        return rect
    }
}
