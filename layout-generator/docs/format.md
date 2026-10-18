# The canvas format

A Dugma canvas is one JSON document. **Save JSON** in the canvas writes it, **Load** reads it, the agent tools (`get_frame` with `full: true`, `write_layout`) move pieces of it, and the self-hosted server keeps it as records (below). The authoritative shape is [`schema/canvas.schema.json`](../schema/canvas.schema.json) (JSON Schema 2020-12). Unknown properties are allowed everywhere: the format grows, older files stay valid.

```
node tools/dugma-cli.mjs validate my-canvas.json
```

## Document

```json
{ "v": 1, "name": "Launch", "view": { "x": 0, "y": 0, "zoom": 0.5 }, "grid": { "unit": 8, "snap": true },
  "frames": [ … ], "library": [ … ], "comments": [ … ] }
```

- `frames`: the screens, in z order (later paints over earlier).
- `library`: this canvas's own components (same shape as shared library items).
- `comments`: pins on screens, with replies and resolved state.

## Frame (a screen)

```json
{ "id": "8wlz04", "name": "App layout (shell)", "x": 0, "y": 0, "theme": "dark",
  "autoLayout": { "v": 2, "mode": "none" }, "clip": true, "hidden": false, "locked": false,
  "layout": { "format": { "id": "custom", "w": 1440, "h": 893 }, "palette": { "bg": "#1F1F1F", "bgToken": "background.paper" }, "blocks": [ … ] } }
```

`x`, `y` place it on the infinite canvas. `layout` is a layout spec: `format` (size, one of the named formats or `custom`), `grid` (the pixel grid the generator used), `palette` (background, foreground, accent; `bgToken` binds the background to a kit color or token), `type` (the type scale), `blocks`, and `meta` (`source`: figma, web, import…; `look`: original, wireframe or rebrand, with `original` kept so looks are lossless). `theme` names the kit theme the screen is on; absent means light.

## Blocks (layers)

Every block has `id` and `kind`, and its box `x`, `y`, `w`, `h` in px from the screen's top left (a child placed by an auto layout stack may leave them out: the layout computes them, and the shared copy stores only intent), and optionally `parent` (the box it sits in: coordinates stay in screen space), `label` (its name in Layers), `hidden`, `locked`, `opacity`, `rotation`, `flipX`/`flipY`, `fill`, `gradient`, `stroke`, `shadow`, `radius`, `mask`.

| kind | what it is | its props |
|---|---|---|
| `box` | a container; with `auto` it is an auto layout stack | `auto`, `clip`, `slot`, children by `parent` |
| `text` | words | `text`, `font` {family, size, weight, lineHeight, letterSpacing, transform, style}, `align`, `role` |
| `list` | items | `items`, `marker`, `font` |
| `button` | a button with a label | `text`, `color` (label), `fill`, `radius`, `font` |
| `image` | a picture | `asset` (id in the assets store), `fit`, `focal`, `placeholder` |
| `field` | a rectangle | `fill`, `alpha`, `radius`, `stroke`; a `diagram` spec draws a diagram in it |
| `shape` | circle, ellipse, pill, quarter | `shape` |
| `line` | a straight line from (x, y) along (w, h) | `width`, `dash` |
| `icon` | a named icon | `name` (`check-circle`, or `set:Name` from an imported set) |
| `logo`, `lockup`, `appicon` | the brand's marks | `variant`, `product` |
| `vector`, `path` | SVG path data | `d`, `viewBox`, `keepAspect`, `fillRule`, `svg`; `pen` for paths drawn with the pen tool |
| `scrim`, `badge`, `rule` | a gradient wash, a numbered dot, a thin rule | `alpha`, `fill` |

Derived values (`lines`, `inkW`, `capacity`, `overflow`) are recomputed from text and font; they can be left out.

### Auto layout

A box (or the screen, through `autoLayout`) with `auto.mode` of `vertical`, `horizontal` or `wrap` lays its children out like Figma: `gap` or `gapAuto` (space between), `pad` (number or `{t, r, b, l}`), `main` and `cross` alignment, `clip`. Children size per axis with `sizeW` / `sizeH`: `fixed`, `hug` or `fill`, with `minW`/`maxW`/`minH`/`maxH`; `absolute: true` takes one out of the flow. Only intent is stored; every viewer computes the same positions.

### Color bindings, tokens and themes

`fill`, `color` (button labels) and `stroke.color` hold plain colors. Next to each, `fillToken` / `colorToken` / `strokeToken` can name what the color is bound to: a brand palette color (`"Acai"`) or, in a kit with tokens, a token (`"primary.main"`, `"background.paper"`, `"text.secondary"`). A kit's tokens are `kit.tokens = { light: { name: hex }, dark: { … } }`. Switching a screen's `theme` rewrites every bound color to that theme's value; plain colors that match the old theme's values get bound first, so a captured screen turns dark as a whole. Components inserted from a kit with tokens bind on the way in.

### Instances

A component inserted from a library stays linked to it. Its top block carries `inst: { of, rev, ov }` (the library item id, the item revision it last matched, and its overrides), and every block in it carries `src`, the id of the block in the item it came from. Overrides are sparse, keyed by `src`: the props that differ (`null` removes one), `{ "hidden": true }` for a block taken out, `dx`/`dy` for a free child moved. When the item changes (an admin updates the component), each instance rebuilds from the new definition and applies its overrides; new blocks get ids derived from the instance and the source (`<instance id>.<source id>`), so two people syncing at once agree. **Detach** drops `inst` and `src`; **Reset overrides** empties `ov`; **Update component** makes an instance the item's new definition, keeping block ids where they match so other instances keep their overrides.

### Slots

A box with `slot: { name, accepts: [itemIds] }` is a place for a component. Empty slots show on the canvas as a dashed outline with their name; a selected slot puts the components that fit first in the Library; agents see slots in `get_frame` and insert into them with `insert_component` (`box_id`). `accepts` empty means anything fits.

## Library items

```json
{ "id": "dui-card", "name": "Card", "category": "code", "approved": true, "created": 1792109209400, "updated": 1792340000000,
  "w": 470, "h": 210, "blocks": [ … from 0,0 … ], "assets": { "a_…": { "url": "…", "w": 800, "h": 600 } },
  "code": { "pkg": "@deel-ui/core", "name": "Card", "spec": { "props": [ … ] } }, "capture": true }
```

Blocks are laid out from `0,0`; `w`/`h` are the item's size. `updated` is the revision instances compare with their `inst.rev`. `code` ties the item to a real component (React export writes it); `capture: true` marks a real render captured from Storybook or a page. Shared libraries keep the same shape in the `libitems` collection (claude.ai) or `server/data/libraries` (self-hosted), with `lib` naming the library.

## Comments

```json
{ "id": "c4ol5ip", "frame": "8wlz04", "x": 540, "y": 931, "by": "u_…", "byName": "", "at": 1792168332937,
  "text": "Does this read well?", "resolved": false, "replies": [ { "id": "r…", "by": "u_…", "at": 1792168400000, "text": "Yes." } ] }
```

`x`, `y` are in the screen's coordinates, so a pin follows its screen.

## How it is stored when shared

Multiplayer splits the document into records, each with `_k` (key), `_v` (version, µs) and `_by` (writer): `meta` (the name), `f~<frame>` (a screen without its blocks; `z` and `order` keep the paint and list order), `b~<frame>~<block>` (one block), `o~<frame>` (the stored original behind a look), `L~<item>` (a canvas library item), `C~<comment>` (a comment), `a~<asset>` (a shared picture). The newest version of a record wins, so two people editing different blocks of one screen never overwrite each other. In claude.ai the records sit in the artifact database (`frames/<id>` documents holding a screen with its blocks, `comments/<id>`, `canvas/meta`; under `projects/<id>/` for a project); on the self-hosted server a room holds them and `GET /api/rooms/<room>` returns them. `tools/dugma-cli.mjs get <room>` folds them back into a document.

## Versioning

`v` is the document version (1). New properties are added, old ones are not repurposed; a reader ignores what it does not know. Blocks created by older versions are migrated on load (`Canvas.migrate`).
