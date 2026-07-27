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

    func rebuild(transcript: Transcript?, edl: EditDecisionList, playheadSource: Double?) {
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

        // Walk the EDL **in program order**, including disabled segments at
        // their sequence position. Three consequences, all intended:
        //   - the transcript reads in the order the episode plays, so moving a
        //     segment moves its text;
        //   - cut words stay inline, struck through, where they were cut —
        //     which is what makes them clickable to recover;
        //   - a duplicated moment appears twice, because it is spoken twice.
        // Words covered by no segment at all (hard-removed) simply don't
        // appear: that material is no longer part of the project.
        for clip in edl.clips {
            let isCut = !clip.enabled

            for index in transcript.wordIndices(inSourceRange: clip.sourceRange) {
                let word = transcript.words[index]
                let midTime = (word.start + word.end) / 2

                let hue = trackHues[word.trackId] ?? 0
                let speakerColor = NSColor(hue: hue, saturation: 0.55, brightness: 0.9, alpha: 1)

                var attributes: [NSAttributedString.Key: Any] = [.font: font]
                if isCut {
                    attributes[.foregroundColor] = NSColor.tertiaryLabelColor
                    attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                } else {
                    attributes[.foregroundColor] = speakerColor
                }
                if let playheadSource, midTime >= playheadSource - 0.25, midTime <= playheadSource + 0.25 {
                    attributes[.backgroundColor] = NSColor.selectedTextBackgroundColor
                }

                let text = word.text + " "
                // NSRange is UTF-16 based (like NSAttributedString.length);
                // `text.count` counts Characters and drifts on emoji/accents.
                let range = NSRange(location: result.length, length: (text as NSString).length)
                result.append(NSAttributedString(string: text, attributes: attributes))
                newDisplays.append(WordDisplay(word: word, index: index, isCut: isCut,
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
            textView.textStorage?.setAttributedString(model.attributed)
            textView.selectedRanges = selection
            context.coordinator.lastRenderedVersion = model.attributed.hash
            didRelayout = true
        }
        if didRelayout {
            context.coordinator.publishWordGeometry(from: textView)
        }
    }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        coordinator.removeKeyMonitor()
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranscriptEditorView
        weak var textView: NSTextView?
        var lastRenderedVersion: Int = 0
        private var keyMonitor: Any?

        init(_ parent: TranscriptEditorView) {
            self.parent = parent
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
