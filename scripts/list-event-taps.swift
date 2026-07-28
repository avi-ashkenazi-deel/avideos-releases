// Lists every CoreGraphics event tap in the current login session.
//
// Why this exists: during first-run bring-up, clicks and keys aimed at the
// (ad-hoc-signed) app produced neither a local NSEvent-monitor hit inside the
// process NOR a global-monitor hit in any other process — the events vanished
// entirely. Misrouted events show up somewhere; destroyed events show up
// nowhere, and the only thing that destroys an event before delivery is a
// FILTERING event tap (kCGEventTapOptionDefault). Input remappers and
// corporate endpoint-security agents install exactly these.
//
//   swift scripts/list-event-taps.swift
//
// Any line marked FILTER with mouseDown=true is a suspect. listen-only taps
// cannot consume events and are exonerated by construction.
import AppKit
import CoreGraphics

var count: UInt32 = 0
CGGetEventTapList(0, nil, &count)
var taps = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count))
let result = CGGetEventTapList(count, &taps, &count)
guard result == .success else {
    print("CGGetEventTapList failed: \(result)")
    exit(1)
}

// CGEventType raw values: leftMouseDown = 1, rightMouseDown = 3, keyDown = 10.
let mouseDownBits: UInt64 = (1 << 1) | (1 << 3)
let keyDownBit: UInt64 = 1 << 10

print("\(count) event taps in this login session:")
for tap in taps.prefix(Int(count)) {
    let owner = NSRunningApplication(processIdentifier: tap.tappingProcess)?.localizedName
        ?? "pid \(tap.tappingProcess)"
    let kind = tap.options == .defaultTap ? "FILTER (can consume events)" : "listen-only"
    let mouse = tap.eventsOfInterest & mouseDownBits != 0
    let keys = tap.eventsOfInterest & keyDownBit != 0
    print("  '\(owner)' (pid \(tap.tappingProcess)) \(kind) enabled=\(tap.enabled) mouseDown=\(mouse) keyDown=\(keys) events=0x\(String(tap.eventsOfInterest, radix: 16))")
}
print("")
print("Suspects: FILTER taps with mouseDown=true. listen-only taps cannot eat events.")
