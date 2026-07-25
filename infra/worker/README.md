# AVideos Studio — Worker backend

A single Cloudflare Worker that is the entire backend for AVideos Studio:
session creation, LiveKit token minting, presigned R2 upload/download URLs,
and the per-session `manifest.json` store.

## Layout

```
src/index.ts     router + endpoint handlers
src/env.ts       Env bindings interface
src/auth.ts      host-key check, upload-grant sign/verify (HMAC, HOST_KEY-derived)
src/tokens.ts    LiveKit AccessToken minting
src/presign.ts   R2 presigned URLs (aws4fetch, SigV4 query signing)
src/manifest.ts  manifest schema + etag-retry read-modify-write
```

## One-time setup

1. **Create the R2 bucket**

   ```sh
   wrangler r2 bucket create avideos-recordings
   ```

2. **Create an R2 API token** (Cloudflare dashboard → R2 → Manage R2 API
   Tokens → "Object Read & Write", scoped to `avideos-recordings`). This
   yields an Access Key ID + Secret Access Key. These are needed because
   presigned URLs are minted against the S3-compatible endpoint — the bucket
   *binding* alone cannot presign.

3. **Fill in `wrangler.toml` vars**: `LIVEKIT_URL`, `PAGES_ORIGIN`,
   `R2_ACCOUNT_ID` (dashboard → R2 → account id in the S3 endpoint), and
   `R2_BUCKET_NAME` if you used a different bucket name.

4. **Set secrets**

   ```sh
   wrangler secret put LIVEKIT_API_KEY
   wrangler secret put LIVEKIT_API_SECRET
   wrangler secret put HOST_KEY            # long random string; also configured in the Mac app
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   ```

   Generate `HOST_KEY` with e.g. `openssl rand -hex 32`.

5. **CORS on the bucket** — browsers PUT chunks directly to presigned R2
   URLs, so the bucket needs a CORS policy (dashboard → bucket → Settings →
   CORS, or `wrangler r2 bucket cors put`):

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

## Deploy

```sh
npm install
npm run typecheck
npm run deploy        # wrangler deploy
```

`wrangler dev` runs it locally (uses a local R2 simulation; presigned URLs
still point at the real S3 endpoint, so uploads need real creds).

## How clients point at it

- **Mac app (host)**: configure the worker origin (e.g.
  `https://avideos-worker.<account>.workers.dev`) and `HOST_KEY`. It calls
  `POST /v1/sessions` with header `x-host-key: <HOST_KEY>` and gets back
  `{sessionId, hostToken, livekitUrl, inviteUrl}`. It shares `inviteUrl` with
  guests, joins LiveKit with `hostToken`, reads
  `GET /v1/sessions/:id/manifest`, lists chunk keys with
  `POST /v1/sessions/:id/downloads/sign {"prefix": "sessions/<id>/"}`, and
  downloads via `POST ... {"keys": [...]}` presigned GETs.
- **Guest pages** (Cloudflare Pages, `web/guest/`): the invite URL carries
  `?room=<sessionId>&api=<worker origin>`; the pages call `join`, `time`,
  `uploads/sign` and `manifest` with the returned upload grant in the
  `x-upload-grant` header.

## API summary

All responses are JSON; errors are `{"error": "message"}` with an
appropriate status. CORS is open (`*`) for all endpoints.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /v1/sessions` | `x-host-key` | body `{displayName?}` → `{sessionId, hostToken, livekitUrl, inviteUrl}` |
| `POST /v1/sessions/:id/join` | none | body `{name}` → `{participantId, token, livekitUrl, uploadGrant, serverTimeMs}` |
| `GET /v1/time` | none | `{serverTimeMs}`, `Cache-Control: no-store` |
| `POST /v1/sessions/:id/uploads/sign` | `x-upload-grant` | `{keys: string[]}` (≤50, within grant prefix, `.webm`/`.json`) → `{urls: [{key, url}], expiresInSeconds}` (1h) |
| `POST /v1/sessions/:id/manifest` | grant or host key | merge patch `{participant?|take?|track?}` → `{ok, manifest}`; grants may only patch their own participant/tracks |
| `GET /v1/sessions/:id/manifest` | `x-host-key` | full manifest |
| `POST /v1/sessions/:id/downloads/sign` | `x-host-key` | `{keys}` (≤100) → presigned GETs, or `{prefix}` → `{keys, truncated}` listing |

### Object layout in R2

```
sessions/{sessionId}/manifest.json
sessions/{sessionId}/{participantId}/{takeId}/{kind}/{index padded to 6}.webm   kind = audio|video
sessions/{sessionId}/{participantId}/{takeId}/{kind}/meta.json
```

### Manifest shape

```jsonc
{
  "id": "k3q0z8m1xw",
  "createdAt": "2026-07-25T12:00:00.000Z",
  "displayName": "Episode 12",
  "participants": [{ "id": "a1b2c3d4", "displayName": "Dana", "role": "guest", "joinedAt": "..." }],
  "takes": [{
    "id": "take-1",
    "startedAtSession": 123456.7,          // session-clock ms
    "tracks": [{
      "participantId": "a1b2c3d4",
      "kind": "video",                      // or "audio"
      "anchor": { "mediaTimeMs": 0, "sessionTimeMs": 123480.2 },
      "chunkTimeline": [{ "chunkIndex": 6, "sessionTimeMs": 153480.9 }],
      "chunkCount": 42,
      "finalized": true,
      "mimeType": "video/webm;codecs=vp9",
      "width": 3840, "height": 2160
    }]
  }]
}
```

Upload grants expire after **24 h** (so upload drains can finish after the
call); guest LiveKit tokens after 4 h; host tokens after 12 h.
