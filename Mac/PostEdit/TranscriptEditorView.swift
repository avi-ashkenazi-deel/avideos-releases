import SwiftUI
import AppKit
import Observation

/// Bidirectional word ↔ clip mapping for the text-based editor. Recomputed
/// O(words) whenever the EDL or transcript changes — transcript and timeline
/// are two views of the same EDL.
@MainActor
@Observable
final class TranscriptEditModel {
    struct WordDisplay {
        var word: Word
        var index: Int
        var isCut: Bool
        var clipID: UUID?
        /// Character range in the rendered attributed string.
        var characterRange: NSRange
    }

    private(set) var displays: [WordDisplay] = []
    private(set) var attributed = NSAttributedString()
    private var trackHues: [String: Double] = [:]

    func rebuild(transcript: Transcript?,
                 edl: EditDecisionList,
                 trackNames: [String: String] = [:]) {
        guard let transcript else {
            displays = []
            attributed = NSAttributedString(string: "Transcribe the session to edit as text.")
            return
        }

        // Speaker colors by track.
        let trackIDs = Array(Set(transcript.words.map(\.trackId))).sorted()
        for (index, id) in trackIDs.enumerated() where trackHues[id] == nil {
            trackHues[id] = Double(index) / Double(max(trackIDs.count, 1))
        }

        let result = NSMutableAttributedString()
        var newDisplays: [WordDisplay] = []
        let font = NSFont.systemFont(ofSize: 15)

        // Paragraphs: Whisper returns one unbroken stream, but the word
        // timings and per-word speaker are enough to break it locally —
        // a new paragraph on every speaker change, on any real pause, and
        // (so a monologue doesn't run forever) at the first natural pause
        // once a paragraph has grown long. Speaker names label paragraphs
        // when the session has more than one voice.
        let showSpeakers = trackIDs.count > 1
        var previousWord: Word?
        var paragraphLength = 0

        func breakParagraph(before word: Word) {
            if previousWord != nil {
                result.append(NSAttributedString(string: "\n\n", attributes: [.font: font]))
            }
            paragraphLength = 0
            if showSpeakers, previousWord?.trackId != word.trackId {
                let name = trackNames[word.trackId] ?? "Speaker"
                result.append(NSAttributedString(string: name + "\n", attributes: [
                    .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]))
            }
        }

        // Walk the EDL **in program order**, including disabled segments at
        // their sequence position. Three consequences, all intended:
        //   - the transcript reads in the order the episode plays, so moving a
        //     segment moves its text;
        //   - a CUT collapses to one small ⌫-marker where the words were —
        //     deleted must read as deleted (struck-through words in place read
        //     as "delete didn't work"; first live test said exactly that).
        //     Clicking the marker restores the cut.
        //   - a duplicated moment appears twice, because it is spoken twice.
        // Words covered by no segment at all (hard-removed) simply don't
        // appear: that material is no longer part of the project.
        // Alternating faint tint per enabled clip, so where one block of the
        // program ends and the next begins is visible IN THE TEXT, not only
        // on the timeline.
        var enabledOrdinal = 0

        for clip in edl.clips {
            let indices = transcript.wordIndices(inSourceRange: clip.sourceRange)

            if !clip.enabled {
                // One compact, clickable marker for the whole cut. Registered
                // as a display on the cut's first word so the existing
                // click-to-recover path works unchanged. A cut with no words
                // (pure silence) gets no marker — there is nothing to read.
                guard let firstIndex = indices.first else { continue }
                let count = indices.count
                let text = "[✂ \(count)] "
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: NSFont.systemFont(ofSize: 11),
                    .foregroundColor: NSColor.tertiaryLabelColor,
                    .toolTip: count == 1 ? "1 word cut — click to restore"
                                         : "\(count) words cut — click to restore",
                ]
                let range = NSRange(location: result.length, length: (text as NSString).length)
                result.append(NSAttributedString(string: text, attributes: attributes))
                newDisplays.append(WordDisplay(word: transcript.words[firstIndex],
                                               index: firstIndex, isCut: true,
                                               clipID: clip.id, characterRange: range))
                continue
            }

            enabledOrdinal += 1
            for index in indices {
                let word = transcript.words[index]

                let pause = previousWord.map { word.start - $0.end } ?? 0
                if previousWord == nil
                    || word.trackId != previousWord?.trackId
                    || pause >= 2.0
                    || (paragraphLength > 450 && pause >= 0.75) {
                    breakParagraph(before: word)
                }
                previousWord = word
                paragraphLength += word.text.count + 1

                let hue = trackHues[word.trackId] ?? 0
                let speakerColor = NSColor(hue: hue, saturation: 0.55, brightness: 0.9, alpha: 1)

                var attributes: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: speakerColor,
                ]
                // Every second clip carries a faint wash; the seam between
                // washes is a cut. (The playhead highlight is a temporary
                // attribute laid over this, applied by the view.)
                if enabledOrdinal.isMultiple(of: 2) {
                    attributes[.backgroundColor] = NSColor.labelColor.withAlphaComponent(0.07)
                }

                let text = word.text + " "
                // NSRange is UTF-16 based (like NSAttributedString.length);
                // `text.count` counts Characters and drifts on emoji/accents.
                let range = NSRange(location: result.length, length: (text as NSString).length)
                result.append(NSAttributedString(string: text, attributes: attributes))
                newDisplays.append(WordDisplay(word: word, index: index, isCut: false,
                                               clipID: clip.id, characterRange: range))
            }
        }

        displays = newDisplays
        attributed = result
    }

    func display(atCharacterIndex characterIndex: Int) -> WordDisplay? {
        displays.first { NSLocationInRange(characterIndex, $0.characterRange) }
    }

    func displays(inCharacterRange range: NSRange) -> [WordDisplay] {
        displays.filter { NSIntersectionRange(range, $0.characterRange).length > 0 }
    }
}

/// Descript-style transcript editing: click a word to seek, click a struck
/// word to recover its clip, select + Delete to cut the words (snapped).
struct TranscriptEditorView: NSViewRepresentable {
    let model: TranscriptEditModel
    /// Playhead in SOURCE seconds — the word under it highlights live, and
    /// while playing the text scrolls to keep it on screen.
    var playheadSource: Double?
    var isPlaying: Bool = false
    var onSeek: (Double) -> Void
    var onDeleteWords: (ClosedRange<Double>) -> Void
    var onRecoverClip: (UUID) -> Void
    /// Where each word ended up on screen, so the vertical timeline can line
    /// its blocks up with the text. Called after every relayout; the caller
    /// turns these into a `TextAlignedScale`.
    var onWordGeometry: ([TimelineTextRun]) -> Void = { _ in }
    /// The EDL the displayed text was built from, needed to convert a word's
    /// position into edited-timeline seconds.
    var edl: EditDecisionList

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        let textView = scrollView.documentView as! NSTextView
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 16, height: 16)
        textView.delegate = context.coordinator
        context.coordinator.textView = textView

        let click = NSClickGestureRecognizer(target: context.coordinator,
                                             action: #selector(Coordinator.handleClick(_:)))
        click.delaysPrimaryMouseButtonEvents = false
        textView.addGestureRecognizer(click)

        // Delete-key handling via a local key monitor scoped to first responder.
        context.coordinator.installKeyMonitor()
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        var didRelayout = false
        if textView.textStorage?.string != model.attributed.string
            || context.coordinator.lastRenderedVersion != model.attributed.hash {
            let selection = textView.selectedRanges
            // Programmatic — the selection-restores below must not read as
            // the user highlighting text (which seeks the video).
            context.coordinator.isApplyingProgrammaticChange = true
            textView.textStorage?.setAttributedString(model.attributed)
            textView.selectedRanges = selection
            context.coordinator.isApplyingProgrammaticChange = false
            context.coordinator.lastRenderedVersion = model.attributed.hash
            // Character ranges may have shifted; the old highlight range is
            // meaningless against the new string.
            context.coordinator.lastHighlightRange = nil
            didRelayout = true
        }
        if didRelayout {
            context.coordinator.publishWordGeometry(from: textView)
        }
        context.coordinator.updatePlayhead(textView: textView,
                                           source: playheadSource,
                                           follow: isPlaying)
    }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        coordinator.removeKeyMonitor()
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranscriptEditorView
        weak var textView: NSTextView?
        var lastRenderedVersion: Int = 0
        var lastHighlightRange: NSRange?
        /// True while updateNSView swaps the string / restores selection, so
        /// the selection-change delegate can tell user highlights from ours.
        var isApplyingProgrammaticChange = false
        private var keyMonitor: Any?

        init(_ parent: TranscriptEditorView) {
            self.parent = parent
        }

        /// Live playhead highlight as a TEMPORARY attribute — rebuilding the
        /// whole attributed string 30 times a second would be unusable. While
        /// playing, the text scrolls to keep the spoken word on screen.
        @MainActor
        func updatePlayhead(textView: NSTextView, source: Double?, follow: Bool) {
            guard let layoutManager = textView.layoutManager else { return }
            var newRange: NSRange?
            if let source {
                newRange = parent.model.displays.first(where: {
                    !$0.isCut && source >= $0.word.start && source <= $0.word.end
                })?.characterRange
            }
            guard newRange != lastHighlightRange else { return }
            let length = textView.textStorage?.length ?? 0
            if let old = lastHighlightRange, NSMaxRange(old) <= length {
                layoutManager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: old)
            }
            if let new = newRange, NSMaxRange(new) <= length {
                layoutManager.addTemporaryAttribute(.backgroundColor,
                                                    value: NSColor.selectedTextBackgroundColor,
                                                    forCharacterRange: new)
                if follow {
                    textView.scrollRangeToVisible(new)
                }
            }
            lastHighlightRange = newRange
        }

        /// Highlighting words shows that moment in the video: seek (paused)
        /// to the first selected word. Programmatic selection restores are
        /// filtered out above.
        func textViewDidChangeSelection(_ notification: Notification) {
            MainActor.assumeIsolated {
                guard !isApplyingProgrammaticChange,
                      let textView,
                      textView.window?.firstResponder === textView else { return }
                let selection = textView.selectedRange()
                guard selection.length > 0,
                      let first = parent.model.displays(inCharacterRange: selection)
                          .first(where: { !$0.isCut }) else { return }
                parent.onSeek(first.word.start)
            }
        }

        // AppKit delivers gesture actions on the main thread, and the model
        // this reads is `@MainActor`. Saying so is what lets the two meet.
        @MainActor
        @objc func handleClick(_ gesture: NSClickGestureRecognizer) {
            guard let textView else { return }
            let point = gesture.location(in: textView)
            let index = textView.characterIndexForInsertion(at: point)
            guard let display = parent.model.display(atCharacterIndex: index) else { return }
            if display.isCut, let clipID = display.clipID {
                parent.onRecoverClip(clipID)
            } else {
                parent.onSeek(display.word.start)
            }
        }

        func installKeyMonitor() {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self,
                      let textView = self.textView,
                      textView.window?.firstResponder === textView,
                      event.keyCode == 51 else { return event }   // 51 = Delete
                let selection = textView.selectedRange()
                guard selection.length > 0 else { return event }
                let words = self.parent.model.displays(inCharacterRange: selection)
                    .filter { !$0.isCut }
                guard let first = words.first, let last = words.last else { return event }
                self.parent.onDeleteWords(first.word.start...last.word.end)
                return nil   // consumed
            }
        }

        /// Measures where each word landed and reports it in edited-timeline
        /// terms, which is what the vertical timeline aligns against.
        ///
        /// Uses the classic TextKit stack — `scrollableTextView()` gives us a
        /// real `NSLayoutManager`, so `boundingRect(forGlyphRange:in:)` is the
        /// direct answer. Runs are emitted per word; the scale collapses
        /// consecutive ones itself.
        @MainActor
        func publishWordGeometry(from textView: NSTextView) {
            guard let layoutManager = textView.layoutManager,
                  let container = textView.textContainer else { return }

            let displays = parent.model.displays
            guard !displays.isEmpty else {
                parent.onWordGeometry([])
                return
            }

            // Word position in the *program*: walk the sequence the same way
            // the transcript was built, so the two agree exactly.
            var runs: [TimelineTextRun] = []
            runs.reserveCapacity(displays.count)
            var timelineStart = 0.0
            var displayIndex = 0
            let inset = textView.textContainerInset.height

            for clip in parent.edl.clips {
                guard displayIndex < displays.count else { break }
                let clipStart = clip.sourceRange.lowerBound

                while displayIndex < displays.count,
                      displays[displayIndex].clipID == clip.id {
                    let display = displays[displayIndex]
                    displayIndex += 1
                    guard clip.enabled else { continue }

                    let glyphRange = layoutManager.glyphRange(
                        forCharacterRange: display.characterRange, actualCharacterRange: nil)
                    let rect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: container)
                    guard rect.height > 0 else { continue }

                    let offsetIntoClip = display.word.start - clipStart
                    let start = max(0, timelineStart + offsetIntoClip)
                    runs.append(TimelineTextRun(startTime: start,
                                                endTime: start + display.word.duration,
                                                minY: rect.minY + inset,
                                                maxY: rect.maxY + inset))
                }
                if clip.enabled { timelineStart += clip.duration }
            }
            parent.onWordGeometry(runs)
        }

        func removeKeyMonitor() {
            if let monitor = keyMonitor {
                NSEvent.removeMonitor(monitor)
                keyMonitor = nil
            }
        }
    }
}
