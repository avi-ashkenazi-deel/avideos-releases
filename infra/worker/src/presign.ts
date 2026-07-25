/**
 * Presigned R2 URLs via the S3-compatible endpoint, signed with aws4fetch.
 *
 * The R2 bucket *binding* handles manifest reads/writes and listing; presigned
 * URLs for direct browser/Mac-app transfers require the S3 API credentials
 * (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ACCOUNT_ID).
 */
import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

let cachedClient: { id: string; client: AwsClient } | null = null;

function s3Client(env: Env): AwsClient {
  if (cachedClient && cachedClient.id === env.R2_ACCESS_KEY_ID) return cachedClient.client;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  cachedClient = { id: env.R2_ACCESS_KEY_ID, client };
  return client;
}

/** Percent-encode each path segment of an object key, preserving slashes. */
function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * Presign a single-object URL.
 * @param method "PUT" for uploads, "GET" for downloads.
 * @param expiresSeconds validity window (R2 max: 7 days).
 */
export async function presignObjectUrl(
  env: Env,
  method: "PUT" | "GET",
  key: string,
  expiresSeconds: number,
): Promise<string> {
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodeKeyPath(key)}`,
  );
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await s3Client(env).sign(new Request(url, { method }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

/** Presign a batch of keys; preserves order. */
export async function presignBatch(
  env: Env,
  method: "PUT" | "GET",
  keys: string[],
  expiresSeconds: number,
): Promise<Array<{ key: string; url: string }>> {
  return Promise.all(
    keys.map(async (key) => ({ key, url: await presignObjectUrl(env, method, key, expiresSeconds) })),
  );
}
