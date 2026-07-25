/**
 * Worker environment bindings.
 *
 * Secrets (set with `wrangler secret put`):
 *   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, HOST_KEY,
 *   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Vars (wrangler.toml [vars]):
 *   LIVEKIT_URL, PAGES_ORIGIN, R2_ACCOUNT_ID, R2_BUCKET_NAME
 *
 * Bindings:
 *   RECORDINGS — R2 bucket used for manifests + object listing. Presigned
 *   URLs are minted against the S3-compatible endpoint using the
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY pair (bucket bindings cannot
 *   produce presigned URLs).
 */
export interface Env {
  LIVEKIT_URL: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  HOST_KEY: string;

  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;

  /** Origin of the Cloudflare Pages guest site, used to build invite URLs. */
  PAGES_ORIGIN: string;

  RECORDINGS: R2Bucket;
}
