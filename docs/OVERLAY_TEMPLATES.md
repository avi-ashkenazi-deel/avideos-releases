# Portable show overlay templates

Status: first native implementation builds and passes five focused template tests. On-screen workflow validation remains pending.

## User outcome

Create a lower-third, caller card or audience-comment design once. Use it in multiple shows, type new content directly inside streamit, and show/hide it without changing the artwork. Export a template and import it into another show. Different shows can have different typefaces and styles.

## Separate design, content and artwork

**Template design** owns named text slots, font/weight/size/spacing, color, layout, safe area, fitting rules, artwork positioning and entry/hold/exit timing. The design editor can change these properties. A normal show operator sees content fields only.

**Instance content** holds the text for a particular use: name, role, caller name, comment author, comment body or show title. Updating it does not modify the template or other instances. Never bake these values into the reusable art video.

**Artwork** contains the reusable visual elements, including transparent motion plates and phone artwork. The approved liquid and transition are independent assets and are unaffected by text edits or theme changes.

## Native operator flow

1. Open Overlays → Templates; choose Lower third, Incoming call or Audience comment.
2. Choose an installed design and fill its clearly named fields.
3. Preview using the real font and artwork. Missing fonts or media are identified before use.
4. Show plays entry once, holds until dismissed, and Hide plays exit to transparency.
5. Edit text in the content panel. Styling remains locked in this panel.
6. Duplicate an instance to reuse the design with different content.

Use a separate Customize design action to change typography or layout. Saving that change makes a new template version or a separate template; do not silently restyle existing shows.

## Export and import

A portable template package contains:

- A versioned manifest, stable template identity and version, human-readable name, template kind, reference canvas and safe area.
- Text slot definitions with labels, optional sample values, supported length/line limits, and fit rules.
- Style definitions and optional mappings to semantic show-theme tokens.
- Layer order, placement, and coordinated entry/hold/exit behavior.
- Relative references to bundled reusable media. No absolute paths, remote dependencies, or project-specific guest/device identifiers.
- Font names and requirements. Include font files only where redistribution rights are established; otherwise provide missing-font resolution.

Exclude live audience messages and current caller/name values by default. Optional sample text must be clearly labeled.

Import is a preview step, then a deliberate choice:

- **Keep original design** (default): retains typography, colors, artwork and timing.
- **Adapt to this show's theme**: explicitly maps text styles to the destination show's typeface and colors, with preview. Artwork and approved transition are not recolored or regenerated implicitly.

Imports create local copies. Name conflicts do not overwrite existing templates. A missing typeface requires an explicit replacement or installation choice; don't silently substitute and call it the same design.

Validate manifest version, allowed media types, file sizes and relative paths before extracting. Reject paths escaping the package. Do not execute scripts contained in an imported template.

## First templates

- Lower third: name and role.
- Incoming call: caller name and optional subtitle; same family and motion grammar as the lower third, with separate reusable phone artwork.
- Audience comment: author and message; readable wrapping and a bounded footprint.
- Show title: editable title only after the reference typography is properly established. Current rejected title video is not a source template.

## Current implementation baseline

streamit already has Codable native text elements, font names, text boxes, placement and whole-element entry/exit animations. The browser study also has editable text, but it is not a native template importer. Existing caption templates are for Clip Studio captions and should not be confused with live broadcast overlays.

Still needed: portable package format and validation, multi-layer template instances, native content-only form, media bundling/import, explicit theme/font resolution, grouped Show/Hide behavior and persistence. Imported HTML must not be treated as a native editable template without a deliberate conversion to the supported schema.

## Acceptance checks

- Export from show A and import into show B with all media available; original design remains identical by default.
- Change caller/name/comment text in B; A, template artwork and transition remain unchanged.
- Explicit theme adaptation changes only mapped styles and leaves source template unchanged.
- Save/reopen a show; content, media references, font choices and template versions survive.
- Show/Hide/replay have synchronized transparent endpoints, no unwanted loops and a readable hold.
- Long comments, long names, accents and different scripts wrap/fit without clipping.
- Missing fonts/media are visible and resolvable; no silent artistic substitution.
- Duplicate imports and unsupported/corrupt packages fail safely without overwriting a working design.

## Implemented first slice

Open the stacked-template icon in the Overlays add bar, or Show Templates in the Comments window. Phone and comment designs create hidden, independent native layers with editable fields and grouped Show/Hide controls. Self-contained vector/text designs can be exported/imported as JSON, without instance text. Imported designs get new identities. Typeface customization saves a design copy. A selected comment design can be stored with the show and applied to live comments.

This is a functional first slice, not final visual approval. External motion-media packaging, full theme mapping, comprehensive text fitting, and custom template layout editing remain future work. The smartphone artwork is still a simple vector prototype. Native on-screen workflow checks are pending; build and model tests passed. A one-line pre-existing RenderEngine initializer issue was corrected to enable compilation.
