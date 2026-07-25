/**
 * Authentication helpers: host-key check and the participant "upload grant".
 *
 * An upload grant is a compact JWT-ish token: base64url(JSON payload) + "." +
 * base64url(HMAC-SHA256 signature). The signing key is derived from HOST_KEY
 * (SHA-256 over a fixed context string + the key) so rotating HOST_KEY
 * invalidates all outstanding grants.
 */
import type { Env } from "./env";

const encoder = new TextEncoder();

const GRANT_CONTEXT = "avideos-upload-grant-v1";
export const UPLOAD_GRANT_HEADER = "x-upload-grant";
export const HOST_KEY_HEADER = "x-host-key";

/** Payload carried inside an upload grant. */
export interface UploadGrant {
  v: 1;
  /** Session id the grant belongs to. */
  sid: string;
  /** Participant id the grant belongs to. */
  pid: string;
  /** Object-key prefix the holder may write under. */
  prefix: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time string comparison (length is not hidden, contents are). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** True when the request carries the correct x-host-key header. */
export function hasValidHostKey(request: Request, env: Env): boolean {
  const provided = request.headers.get(HOST_KEY_HEADER);
  if (!provided || !env.HOST_KEY) return false;
  return timingSafeEqual(provided, env.HOST_KEY);
}

// Derived-key cache — the derivation is cheap but there is no reason to
// repeat it on every request within an isolate.
let cachedKey: { hostKey: string; key: CryptoKey } | null = null;

async function grantKey(env: Env): Promise<CryptoKey> {
  if (cachedKey && cachedKey.hostKey === env.HOST_KEY) return cachedKey.key;
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${GRANT_CONTEXT}:${env.HOST_KEY}`),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  cachedKey = { hostKey: env.HOST_KEY, key };
  return key;
}

/** Mint an upload grant scoping `participantId` to its per-session prefix. */
export async function signUploadGrant(
  env: Env,
  sessionId: string,
  participantId: string,
  ttlSeconds: number,
): Promise<string> {
  const payload: UploadGrant = {
    v: 1,
    sid: sessionId,
    pid: participantId,
    prefix: `sessions/${sessionId}/${participantId}/`,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await grantKey(env), encoder.encode(body)),
  );
  return `${body}.${b64urlEncode(sig)}`;
}

/**
 * Verify an upload grant string. Returns the payload when the signature is
 * valid and the grant has not expired, otherwise null.
 */
export async function verifyUploadGrant(env: Env, token: string): Promise<UploadGrant | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));
  if (!sig) return null;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await grantKey(env),
    sig as unknown as ArrayBuffer,
    encoder.encode(body) as unknown as ArrayBuffer,
  );
  if (!valid) return null;

  const payloadBytes = b64urlDecode(body);
  if (!payloadBytes) return null;
  let payload: UploadGrant;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (typeof payload.sid !== "string" || typeof payload.pid !== "string") return null;
  if (typeof payload.prefix !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** Extract and verify the upload grant header from a request. */
export async function grantFromRequest(request: Request, env: Env): Promise<UploadGrant | null> {
  const token = request.headers.get(UPLOAD_GRANT_HEADER);
  if (!token) return null;
  return verifyUploadGrant(env, token);
}
