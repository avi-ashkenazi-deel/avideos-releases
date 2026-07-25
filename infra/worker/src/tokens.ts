/**
 * LiveKit access-token minting. Room name always equals the session id.
 */
import { AccessToken } from "livekit-server-sdk";
import type { Env } from "./env";

/** 12h host token: room admin, publish + subscribe + data. */
export async function mintHostToken(env: Env, sessionId: string): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: "host",
    name: "Host",
    ttl: "12h",
  });
  at.addGrant({
    room: sessionId,
    roomJoin: true,
    roomAdmin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

/** 4h guest token: publish + subscribe + data, no admin. */
export async function mintGuestToken(
  env: Env,
  sessionId: string,
  participantId: string,
  displayName: string,
): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: participantId,
    name: displayName,
    ttl: "4h",
  });
  at.addGrant({
    room: sessionId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}
