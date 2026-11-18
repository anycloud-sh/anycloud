import type { CloudflareCreds } from './cloud.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 15_000;

interface VerifyResponse {
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: { id?: string; status?: string };
}

/**
 * Confirm the token is active and return its ID, which R2 uses as the S3
 * access key ID. Account-owned tokens verify under the account and user
 * tokens under /user, so a token passes if either answers active.
 */
export async function verifyCloudflareToken(
  credential: Pick<CloudflareCreds, 'accountId' | 'apiToken'>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const reasons: string[] = [];
  for (const path of [
    `/accounts/${encodeURIComponent(credential.accountId)}/tokens/verify`,
    '/user/tokens/verify',
  ]) {
    const response = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
      headers: { Authorization: `Bearer ${credential.apiToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as VerifyResponse;
    const { id, status } = body.result ?? {};
    if (response.ok && body.success && status === 'active' && id) {
      return { id };
    }
    reasons.push(
      status && status !== 'active'
        ? `token is ${status}`
        : (body.errors ?? []).map((e) => e.message).join('; ') ||
            `HTTP ${response.status}`,
    );
  }
  throw new Error(
    `Cloudflare rejected the API token: ${[...new Set(reasons)].join('; ')}`,
  );
}
