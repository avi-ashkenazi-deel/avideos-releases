# superavi.com

Avi Ashkenazi's portfolio — a strictly typographic, black/white, Helvetica-Neue
site with WebGL. Built with **React + Vite + React Three Fiber**. Front-end only,
no backend; all content lives in editable data files.

> Note: this `web/` directory is a standalone web app living inside a repository
> that otherwise contains an unrelated iOS app. They do not interact.

## Run

```bash
cd web
npm install
npm run dev        # local dev with HMR
npm run build      # typecheck + production build -> dist/
npm run preview    # serve the production build locally
npm run typecheck  # tsc --noEmit
```

## Sections / routes

`/` Home (WebGL hero) · `/writing` · `/talks` · `/projects` (+ `/projects/:id`) ·
`/tools` · `/gallery` (project gallery) · `/photography` · `/about` · `/socials`.

Galleries are infinite, drag-to-explore 3D fields. Click an image to open it;
use Prev/Next or Close. Items are deep-linkable, e.g. `/photography/p03`.

On desktop the site scrolls with a top nav. On mobile each section is a full
page; new sections slide up like a native sheet, and you can swipe left/right
between them. It installs as a PWA.

## Editing content

All content is in `src/data/` (typed by `src/data/types.ts`):

- `about.ts` — name, one-line bio (home), full bio (About page)
- `writing.ts` — curated posts (LinkedIn / Blog / Substack) with external links
- `talks.ts` — talks with dates and watch links
- `tools.ts` — apps you've built (thumbnail + url)
- `projects.ts` — richer project entries (used by `/projects` + detail pages)
- `gallery.photography.ts` / `gallery.projects.ts` — gallery images
  (currently the real archive from superavi.com/portfolio, stored in
  `public/images/portfolio/`; the source only serves 176×88 thumbnails, so swap
  in higher-resolution files under the same filenames to sharpen the zoom view)
- `socials.ts` — social links

### Adding images

Drop files in `public/images/{photography,projects,tools}/` and set the `src`
(galleries) / `thumbnail` / `cover` path in the matching data file. For gallery
items, set `width`/`height` to the image's intrinsic pixels so the floating plane
gets the right aspect ratio.

Until a real image is set, galleries render a colorful procedural placeholder and
tool/project thumbnails render an on-brand typographic placeholder.

### Fonts

Helvetica Neue is licensed and is **not** bundled — Apple devices use it natively.
For a consistent fallback elsewhere, drop `Inter-Regular.woff2` and
`Inter-Medium.woff2` into `public/fonts/` (already wired in `typography.css`).

## Deploy

`dist/` is fully static. Host on Cloudflare Pages / Vercel / Netlify with the
build root set to `web/` (build: `npm run build`, output: `dist`), then point the
`superavi.com` domain at it.

## Tech notes

- `src/three/` — hero shader (domain-warped greyscale noise + grain + vignette)
- `src/components/gallery/` — infinite field uses modulo-wrapped plane positions
  and `@use-gesture` drag; `@react-spring`-style lerping for momentum and zoom
- `src/components/layout/` — responsive shell, animated routes, mobile sheets
