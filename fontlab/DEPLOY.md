# Deploying FontLab

FontLab is a static site. There is no server to run and no database: build it,
upload one folder, done. Live sessions connect browsers to each other directly.

## Build

```
cd fontlab
npm ci
npm run build        # → dist/
```

`dist/` is the whole site. Asset paths are relative, so the same build works at
the root of a domain (`https://fonts.example.com/`) and inside any sub-folder
(`https://example.com/tools/fontlab/`) with no configuration.

Check the build locally the way a host would serve it (plain files, no dev server):

```
npm run serve:dist   # http://127.0.0.1:5199/  and  http://127.0.0.1:5199/sub/fontlab/
npm run test:dist    # builds, then runs the browser tests against dist/ at both addresses
```

Every push also builds and tests the site in GitHub Actions and attaches it to
the run as the `fontlab-site` artifact, ready to upload anywhere.

## Where to put it

Any static host works. Settings for the common ones:

| Host | Root directory | Build command | Output |
|---|---|---|---|
| Cloudflare Pages | `fontlab` | `npm run build` | `dist` |
| Netlify | `fontlab` | `npm run build` | `dist` |
| Vercel | `fontlab` | `npm run build` | `dist` (framework preset: Vite or Other) |
| GitHub Pages (its own repository) | — | see below | `fontlab/dist` |
| Your own server (nginx, S3, …) | — | build locally | upload `dist/` |

Requirements for the host:

- **HTTPS.** Browsers only allow direct connections (WebRTC), clipboard and
  storage features on secure pages. `localhost` counts as secure for testing.
- Nothing else: no rewrites, no special headers. Session links are
  `…/index-address/?join=CODE`, a query on the one page.

GitHub Pages in a repository of its own (do **not** enable this in a repository
whose Pages site already serves something else, it would replace it):

```yaml
# .github/workflows/pages.yml
name: Deploy FontLab
on: { push: { branches: [main] }, workflow_dispatch: {} }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: fontlab-pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: fontlab } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: fontlab/package-lock.json }
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: fontlab/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## What the site talks to

Everything a visitor draws stays in their browser (IndexedDB). The site makes
outbound requests only for:

| What | Where | When |
|---|---|---|
| Variable font, .ttf, combine weights | `cdn.jsdelivr.net` (Pyodide + fontTools, ~12 MB, cached) | first use of those exports |
| Live sessions: finding each other | `0.peerjs.com` (PeerJS public broker, WebSocket) | starting or joining a session |
| Live sessions: the font itself | straight between the browsers (WebRTC, encrypted); via a TURN relay only when a direct path is impossible | during a session |

If the host adds a Content-Security-Policy, allow those origins
(`script-src`/`connect-src` for jsDelivr, `connect-src` for the broker,
`worker-src blob:`, `font-src data: blob:`).

## Tuning a deployment without rebuilding

`dist/fontlab.config.json` is read when the page loads. Edit it on the server;
no rebuild needed. Everything is optional:

```json
{
  "collab": {
    "peer": { "host": "peer.example.com", "port": 443, "path": "/fl", "secure": true },
    "iceServers": [
      { "urls": "stun:stun.example.com:3478" },
      { "urls": "turn:turn.example.com:3478", "username": "user", "credential": "secret" }
    ],
    "maxIdleSeconds": 45
  }
}
```

- `peer`: your own [PeerServer](https://github.com/peers/peerjs-server) instead
  of the public broker (`npx peerjs --port 9000 --path /fl` behind HTTPS). The
  broker only introduces browsers to each other; it never sees the font.
- `iceServers`: STUN/TURN servers. A TURN server is what makes sessions work on
  strict office networks that block direct connections. Note that anything in
  this file is public, so use short-lived TURN credentials if your provider
  offers them.
- `maxIdleSeconds`: how long someone can sit on a letter without touching
  anything before others may edit it (10–3600, default 45).

## Testing live sessions on a deployment

1. Open the site, draw or import something, click **Share**, start a session.
2. Open the link on a second device, ideally on a different network (phone on
   mobile data is the honest test).
3. Edit on both sides; each should see the other's changes, pointer and letter.
4. Reload the host: the link stays the same and the guest reconnects by itself
   within a few seconds. Reload the guest: it rejoins without a dialog.
5. If the guest cannot join from an office network, add a TURN server in
   `fontlab.config.json` and try again.

Tabs of one browser can also share a session without any network by adding
`?via=local` to the address (this is what the automated tests use).

## What is and is not covered by automated tests

- Covered: the build served from `/` and from a sub-folder (generate, import,
  export, a shared session); sessions between two tabs (edits both ways, one
  person per letter, watch-only, notes, reload and reconnect, idle release);
  the sync engine under hundreds of randomised concurrent-edit runs.
- Verified by hand in this repository's test environment: a real WebRTC session
  through the public broker on the built site, including a host reload.
- Not covered: connections across real firewalls and NATs, and TURN relays.
  That is what the first test on a real deployment is for.
