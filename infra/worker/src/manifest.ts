/**
 * Session manifest storage: sessions/{id}/manifest.json in R2.
 *
 * Shape:
 * {
 *   id: string,
 *   createdAt: string (ISO-8601),
 *   displayName?: string,
 *   participants: [{ id, displayName, role, joinedAt }],
 *   takes: [{
 *     id, startedAtSession?,           // session-clock ms when the take started
 *     tracks: [{
 *       participantId, kind,           // kind: "audio" | "video"
 *       anchor?: { mediaTimeMs, sessionTimeMs },
 *       chunkCount?, chunkTimeline?: [{ chunkIndex, sessionTimeMs }],
 *       finalized?, mimeType?, width?, height?
 *     }]
 *   }]
 * }
 *
 * Writes go through an etag-conditioned read-modify-write loop (3 attempts),
 * which is enough for the expected write rate (a handful of writers, patches
 * seconds apart). A lost patch is re-sendable by the client.
 */
import type { Env } from "./env";

export interface TrackAnchor {
  mediaTimeMs: number;
  sessionTimeMs: number;
}

export interface TimelineEntry {
  chunkIndex: number;
  sessionTimeMs: number;
}

export interface ManifestTrack {
  participantId: string;
  kind: string;
  anchor?: TrackAnchor;
  chunkCount?: number;
  chunkTimeline?: TimelineEntry[];
  finalized?: boolean;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface ManifestTake {
  id: string;
  startedAtSession?: number;
  tracks: ManifestTrack[];
}

export interface ManifestParticipant {
  id: string;
  displayName: string;
  role: string;
  joinedAt?: string;
}

export interface Manifest {
  id: string;
  createdAt: string;
  displayName?: string;
  participants: ManifestParticipant[];
  takes: ManifestTake[];
}

/** Merge patch accepted by POST /v1/sessions/:id/manifest. */
export interface ManifestPatch {
  participant?: { id: string; displayName?: string; role?: string };
  take?: { id: string; startedAtSession?: number };
  track?: {
    participantId: string;
    takeId: string;
    kind: string;
    anchor?: TrackAnchor;
    chunkCount?: number;
    chunkTimeline?: TimelineEntry[];
    finalized?: boolean;
    mimeType?: string;
    width?: number;
    height?: number;
  };
}

export function manifestKey(sessionId: string): string {
  return `sessions/${sessionId}/manifest.json`;
}

export async function createManifest(
  env: Env,
  sessionId: string,
  displayName?: string,
): Promise<Manifest> {
  const manifest: Manifest = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    ...(displayName ? { displayName } : {}),
    participants: [],
    takes: [],
  };
  await env.RECORDINGS.put(manifestKey(sessionId), JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return manifest;
}

export async function getManifest(env: Env, sessionId: string): Promise<Manifest | null> {
  const obj = await env.RECORDINGS.get(manifestKey(sessionId));
  if (!obj) return null;
  return (await obj.json()) as Manifest;
}

export async function sessionExists(env: Env, sessionId: string): Promise<boolean> {
  return (await env.RECORDINGS.head(manifestKey(sessionId))) !== null;
}

function findOrCreateTake(manifest: Manifest, takeId: string): ManifestTake {
  let take = manifest.takes.find((t) => t.id === takeId);
  if (!take) {
    take = { id: takeId, tracks: [] };
    manifest.takes.push(take);
  }
  if (!Array.isArray(take.tracks)) take.tracks = [];
  return take;
}

/** Apply a merge patch in place. Upserts; never deletes. */
export function applyPatch(manifest: Manifest, patch: ManifestPatch): void {
  if (patch.participant) {
    const p = patch.participant;
    const existing = manifest.participants.find((x) => x.id === p.id);
    if (existing) {
      if (p.displayName !== undefined) existing.displayName = p.displayName;
      if (p.role !== undefined) existing.role = p.role;
    } else {
      manifest.participants.push({
        id: p.id,
        displayName: p.displayName ?? "",
        role: p.role ?? "guest",
        joinedAt: new Date().toISOString(),
      });
    }
  }

  if (patch.take) {
    const take = findOrCreateTake(manifest, patch.take.id);
    if (patch.take.startedAtSession !== undefined) {
      take.startedAtSession = patch.take.startedAtSession;
    }
  }

  if (patch.track) {
    const t = patch.track;
    const take = findOrCreateTake(manifest, t.takeId);
    let track = take.tracks.find((x) => x.participantId === t.participantId && x.kind === t.kind);
    if (!track) {
      track = { participantId: t.participantId, kind: t.kind };
      take.tracks.push(track);
    }
    if (t.anchor !== undefined) track.anchor = t.anchor;
    if (t.chunkCount !== undefined) {
      track.chunkCount = Math.max(track.chunkCount ?? 0, t.chunkCount);
    }
    if (t.chunkTimeline !== undefined) track.chunkTimeline = t.chunkTimeline;
    if (t.finalized !== undefined) track.finalized = track.finalized || t.finalized;
    if (t.mimeType !== undefined) track.mimeType = t.mimeType;
    if (t.width !== undefined) track.width = t.width;
    if (t.height !== undefined) track.height = t.height;
  }
}

/**
 * Etag-conditioned read-modify-write. Retries up to 3 times on a concurrent
 * writer; returns the updated manifest or null when the session is unknown.
 * Throws on persistent contention.
 */
export async function updateManifest(
  env: Env,
  sessionId: string,
  patch: ManifestPatch,
): Promise<Manifest | null> {
  const key = manifestKey(sessionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const obj = await env.RECORDINGS.get(key);
    if (!obj) return null;
    const manifest = (await obj.json()) as Manifest;
    applyPatch(manifest, patch);
    const result = await env.RECORDINGS.put(key, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: obj.etag },
    });
    if (result) return manifest;
    // Lost the race — brief jittered backoff, then re-read.
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error("manifest write contention: retries exhausted");
}
