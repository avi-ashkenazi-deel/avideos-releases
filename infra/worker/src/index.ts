/**
 * AVideos Studio backend — a single Cloudflare Worker.
 *
 * Endpoints (all JSON, versioned under /v1):
 *   POST /v1/sessions                       host key   create session
 *   POST /v1/sessions/:id/join              public     guest join
 *   GET  /v1/time                           public     server clock
 *   POST /v1/sessions/:id/uploads/sign      grant      presigned PUT batch
 *   POST /v1/sessions/:id/manifest          grant|host manifest merge patch
 *   GET  /v1/sessions/:id/manifest          host key   read manifest
 *   POST /v1/sessions/:id/downloads/sign    host key   presigned GET batch / list
 */
import {
  grantFromRequest,
  hasValidHostKey,
  signUploadGrant,
  type UploadGrant,
} from "./auth";
import type { Env } from "./env";
import {
  createManifest,
  getManifest,
  sessionExists,
  updateManifest,
  type ManifestPatch,
} from "./manifest";
import { presignBatch } from "./presign";
import { mintGuestToken, mintHostToken } from "./tokens";

const SESSION_ID_LENGTH = 10;
const PARTICIPANT_ID_LENGTH = 8;
const UPLOAD_GRANT_TTL_SECONDS = 24 * 60 * 60; // outlives the call so drains can finish
const PRESIGN_PUT_TTL_SECONDS = 60 * 60;
const PRESIGN_GET_TTL_SECONDS = 60 * 60;
const MAX_UPLOAD_KEYS = 50;
const MAX_DOWNLOAD_KEYS = 100;
const MAX_KEY_LENGTH = 512;
const MAX_BODY_BYTES = 256 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-host-key, x-upload-grant",
  "access-control-max-age": "86400",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** Cryptographically random lowercase base36 id. */
function randomBase36(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(length * 2); // oversample to reduce modulo bias
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    // Rejection sampling: 252 = 36 * 7, the largest multiple of 36 <= 256.
    if (bytes[i] < 252) out += alphabet[bytes[i] % 36];
  }
  while (out.length < length) {
    const extra = new Uint8Array(1);
    crypto.getRandomValues(extra);
    if (extra[0] < 252) out += alphabet[extra[0] % 36];
  }
  return out;
}

function isValidSessionId(id: string): boolean {
  return /^[0-9a-z]{6,20}$/.test(id);
}

/** Parse a small JSON body; returns null on absent/invalid/oversized input. */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    if (text.trim() === "") return {};
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Validate an object key a client wants signed.
 * @param prefix required key prefix (grant scope or `sessions/{id}/`).
 * @param suffixes allowed file extensions.
 */
function isValidKey(key: unknown, prefix: string, suffixes: string[]): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (!key.startsWith(prefix)) return false;
  if (key.includes("..") || key.includes("//") || key.includes("\\")) return false;
  if (!/^[A-Za-z0-9/_.\-]+$/.test(key)) return false;
  return suffixes.some((s) => key.endsWith(s));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /v1/sessions — host creates a session. */
async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  if (!hasValidHostKey(request, env)) return errorResponse(401, "invalid host key");

  const body = await readJsonBody(request);
  if (body === null) return errorResponse(400, "invalid JSON body");
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim().slice(0, 128) : undefined;

  const sessionId = randomBase36(SESSION_ID_LENGTH);
  await createManifest(env, sessionId, displayName || undefined);
  const hostToken = await mintHostToken(env, sessionId);

  const workerOrigin = new URL(request.url).origin;
  let inviteUrl: string;
  try {
    const invite = new URL(env.PAGES_ORIGIN);
    invite.searchParams.set("room", sessionId);
    invite.searchParams.set("api", workerOrigin);
    inviteUrl = invite.toString();
  } catch {
    // PAGES_ORIGIN misconfigured — still return a usable relative form.
    inviteUrl = `?room=${sessionId}&api=${encodeURIComponent(workerOrigin)}`;
  }

  return json({
    sessionId,
    hostToken,
    livekitUrl: env.LIVEKIT_URL,
    inviteUrl,
  });
}

/** POST /v1/sessions/:id/join — guest (or prompter) joins. */
async function handleJoin(request: Request, env: Env, sessionId: string): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return errorResponse(400, "invalid JSON body");
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (!rawName) return errorResponse(400, "name is required");
  const name = rawName.slice(0, 64);

  if (!(await sessionExists(env, sessionId))) return errorResponse(404, "session not found");

  const participantId = randomBase36(PARTICIPANT_ID_LENGTH);
  const [token, uploadGrant] = await Promise.all([
    mintGuestToken(env, sessionId, participantId, name),
    signUploadGrant(env, sessionId, participantId, UPLOAD_GRANT_TTL_SECONDS),
  ]);

  // Record the participant server-side so the manifest is complete even if
  // the client never sends a patch. Contention here must not fail the join —
  // the client can re-send a participant patch later.
  try {
    await updateManifest(env, sessionId, {
      participant: { id: participantId, displayName: name, role: "guest" },
    });
  } catch (err) {
    console.warn("join: participant manifest patch lost to contention", err);
  }

  return json({
    participantId,
    token,
    livekitUrl: env.LIVEKIT_URL,
    uploadGrant,
    serverTimeMs: Date.now(),
  });
}

/** GET /v1/time — clock-sync endpoint, aggressively uncached. */
function handleTime(): Response {
  return json(
    { serverTimeMs: Date.now() },
    200,
    { "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache", expires: "0" },
  );
}

/** POST /v1/sessions/:id/uploads/sign — grant-authed presigned PUT batch. */
async function handleUploadsSign(request: Request, env: Env, sessionId: string): Promise<Response> {
  const grant = await grantFromRequest(request, env);
  if (!grant || grant.sid !== sessionId) {
    return errorResponse(401, "invalid or expired upload grant");
  }

  const body = await readJsonBody(request);
  if (body === null) return errorResponse(400, "invalid JSON body");
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_UPLOAD_KEYS) {
    return errorResponse(400, `keys must be a non-empty array of at most ${MAX_UPLOAD_KEYS}`);
  }
  for (const key of keys) {
    if (!isValidKey(key, grant.prefix, [".webm", ".json"])) {
      return errorResponse(400, `key outside grant scope or invalid: ${String(key).slice(0, 128)}`);
    }
  }

  const urls = await presignBatch(env, "PUT", keys as string[], PRESIGN_PUT_TTL_SECONDS);
  return json({ urls, expiresInSeconds: PRESIGN_PUT_TTL_SECONDS });
}

/** POST /v1/sessions/:id/manifest — merge patch (grant or host key). */
async function handleManifestPatch(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  let grant: UploadGrant | null = null;
  if (!hasValidHostKey(request, env)) {
    grant = await grantFromRequest(request, env);
    if (!grant || grant.sid !== sessionId) {
      return errorResponse(401, "host key or valid upload grant required");
    }
  }

  const body = await readJsonBody(request);
  if (body === null) return errorResponse(400, "invalid JSON body");
  const patch = body as ManifestPatch;
  if (!patch.participant && !patch.take && !patch.track) {
    return errorResponse(400, "patch must include participant, take, or track");
  }

  // Basic shape checks.
  if (patch.participant && typeof patch.participant.id !== "string") {
    return errorResponse(400, "participant.id is required");
  }
  if (patch.take && typeof patch.take.id !== "string") {
    return errorResponse(400, "take.id is required");
  }
  if (
    patch.track &&
    (typeof patch.track.participantId !== "string" ||
      typeof patch.track.takeId !== "string" ||
      typeof patch.track.kind !== "string")
  ) {
    return errorResponse(400, "track.participantId, track.takeId, track.kind are required");
  }

  // A grant may only touch its own participant's records.
  if (grant) {
    if (patch.participant && patch.participant.id !== grant.pid) {
      return errorResponse(403, "grant may only patch its own participant");
    }
    if (patch.track && patch.track.participantId !== grant.pid) {
      return errorResponse(403, "grant may only patch its own tracks");
    }
  }

  try {
    const manifest = await updateManifest(env, sessionId, patch);
    if (!manifest) return errorResponse(404, "session not found");
    return json({ ok: true, manifest });
  } catch {
    return errorResponse(503, "manifest is busy, retry the patch");
  }
}

/** GET /v1/sessions/:id/manifest — host reads the manifest. */
async function handleManifestGet(request: Request, env: Env, sessionId: string): Promise<Response> {
  if (!hasValidHostKey(request, env)) return errorResponse(401, "invalid host key");
  const manifest = await getManifest(env, sessionId);
  if (!manifest) return errorResponse(404, "session not found");
  return json(manifest, 200, { "cache-control": "no-store" });
}

/**
 * POST /v1/sessions/:id/downloads/sign — host-only.
 * Body {keys: string[]} → presigned GET urls.
 * Body {prefix: string} → list of object keys under the prefix (paginated
 * internally; up to 5000 keys returned).
 */
async function handleDownloadsSign(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<Response> {
  if (!hasValidHostKey(request, env)) return errorResponse(401, "invalid host key");

  const body = await readJsonBody(request);
  if (body === null) return errorResponse(400, "invalid JSON body");
  const scope = `sessions/${sessionId}/`;

  if (typeof body.prefix === "string") {
    const prefix = body.prefix;
    if (!prefix.startsWith(scope) || prefix.includes("..")) {
      return errorResponse(400, "prefix must be within the session scope");
    }
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.RECORDINGS.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) keys.push(obj.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && keys.length < 5000);
    return json({ keys, truncated: keys.length >= 5000 });
  }

  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_DOWNLOAD_KEYS) {
    return errorResponse(
      400,
      `provide {prefix} or {keys} with at most ${MAX_DOWNLOAD_KEYS} entries`,
    );
  }
  for (const key of keys) {
    if (!isValidKey(key, scope, [".webm", ".json"])) {
      return errorResponse(400, `key outside session scope or invalid: ${String(key).slice(0, 128)}`);
    }
  }
  const urls = await presignBatch(env, "GET", keys as string[], PRESIGN_GET_TTL_SECONDS);
  return json({ urls, expiresInSeconds: PRESIGN_GET_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/v1/time" && request.method === "GET") {
        return handleTime();
      }
      if (path === "/v1/sessions" && request.method === "POST") {
        return await handleCreateSession(request, env);
      }

      const match = path.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
      if (match) {
        const sessionId = match[1];
        const rest = match[2] ?? "";
        if (!isValidSessionId(sessionId)) return errorResponse(400, "invalid session id");

        if (rest === "join" && request.method === "POST") {
          return await handleJoin(request, env, sessionId);
        }
        if (rest === "uploads/sign" && request.method === "POST") {
          return await handleUploadsSign(request, env, sessionId);
        }
        if (rest === "downloads/sign" && request.method === "POST") {
          return await handleDownloadsSign(request, env, sessionId);
        }
        if (rest === "manifest" && request.method === "POST") {
          return await handleManifestPatch(request, env, sessionId);
        }
        if (rest === "manifest" && request.method === "GET") {
          return await handleManifestGet(request, env, sessionId);
        }
      }

      return errorResponse(404, "not found");
    } catch (err) {
      console.error("unhandled error", err instanceof Error ? err.stack : err);
      return errorResponse(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
