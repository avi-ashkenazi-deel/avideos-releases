import Foundation

/// One-click cleanup passes over the EDL. Each pass returns the affected
/// clip ids so the UI can preview/undo; micro-fades at automated boundaries
/// are CompositionBuilder's job (it ramps every cut join), so these passes
/// only decide WHERE the cuts go.
enum AutoCleanup {
    struct Result {
        var cutsMade: Int
        var secondsRemoved: Double
    }

    /// (a) Remove filler words: every disfluency word becomes a disabled
    /// clip (.cutFiller), boundaries snapped to silence so speech is never
    /// clipped mid-phoneme.
    static func removeFillers(edl: inout EditDecisionList,
                              transcript: Transcript,
                              snapper: SilenceSnapper?,
                              extraFillers: Set<String> = []) -> Result {
        var cuts = 0
        var removed = 0.0
        for word in transcript.words {
            let isFiller = word.isDisfluency
                || extraFillers.contains(ScriptAligner.normalizeToken(word.text))
            guard isFiller else { continue }

            var start = word.start
            var end = word.end
            if let snapper {
                // Snap outward only within the word's neighborhood: the
                // filler must vanish entirely, so grow, never shrink.
                start = min(start, snapper.snap(start, within: 0.15))
                end = max(end, snapper.snap(end, within: 0.15))
            }
            guard end > start else { continue }
            let ids = edl.deleteRange(start...end, label: .cutFiller)
            if !ids.isEmpty {
                cuts += 1
                removed += end - start
            }
        }
        return Result(cutsMade: cuts, secondsRemoved: removed)
    }

    /// (b) Tighten silences: pauses longer than `threshold` shrink to
    /// `target` seconds — cut the middle of the pause, keep `target/2` of
    /// breathing room on each side. Cuts land INSIDE silence by construction.
    static func tightenSilences(edl: inout EditDecisionList,
                                snapper: SilenceSnapper,
                                threshold: Double = 1.5,
                                target: Double = 0.4) -> Result {
        var cuts = 0
        var removed = 0.0
        for pause in snapper.pauses(longerThan: threshold) {
            let keep = target / 2
            let cutStart = pause.lowerBound + keep
            let cutEnd = pause.upperBound - keep
            guard cutEnd - cutStart > 0.1 else { continue }
            let ids = edl.deleteRange(cutStart...cutEnd, label: .cutSilence)
            if !ids.isEmpty {
                cuts += 1
                removed += cutEnd - cutStart
            }
        }
        return Result(cutsMade: cuts, secondsRemoved: removed)
    }

    /// Reverses a cleanup pass by recovering every clip with the label.
    static func recoverAll(label: ClipLabel, edl: inout EditDecisionList) {
        for clip in edl.clips where clip.label == label && !clip.enabled {
            _ = edl.recoverClip(id: clip.id)
        }
    }
}
