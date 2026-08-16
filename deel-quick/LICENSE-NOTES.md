# License notes — decision record

## Why we did not vendor SingleFile

[SingleFile / single-file-core](https://github.com/gildas-lormeau/SingleFile)
is the best-known "save a page as one HTML file" implementation and was the
obvious candidate for the capture pipeline. We chose **not** to vendor it:

1. **License.** SingleFile is AGPL-3.0. Internal, non-distributed use is
   legally workable, but bundling AGPL code into a Deel-internal extension
   invites a compliance review and ongoing "is this distribution?" questions
   that a prototyping tool doesn't need.
2. **Scope mismatch.** SingleFile solves the general problem (arbitrary
   websites, frames, a large option surface). We target exactly one SPA
   family — the Deel web app — and need hooks SingleFile doesn't prioritize:
   a per-category byte ledger against the 16MB artifact ceiling, used-font
   filtering via `document.fonts`, canvas chart snapshotting, link
   neutralization with `data-orig-href` preservation, and a metadata contract
   with the quick-iterate skill.

The capture pipeline in `extension/capture/` (~900 lines of plain JS) is
original code written for this tool. It shares standard, unprotectable
techniques with any page-capture implementation (DOM cloning, CSSOM
serialization, data-URI inlining) but no SingleFile code.

## This tool

Deel-internal. Not for distribution outside Deel. If that changes, do a
proper license/OSS review first (and pick a license for this code).

## Third-party code

None. The extension and skill have zero runtime dependencies — no npm, no
bundler, no vendored libraries.
