/**
 * Bearer-token provider backed by the already-authenticated `gcloud` CLI.
 * Used to call Vertex AI's OpenAI-compatible endpoint without a static API key.
 * Tokens are cached and refreshed (~1h lifetime).
 *
 * On a Raspberry Pi running 24/7, prefer Application Default Credentials with a
 * service account (see docs/raspberry-pi-setup.md) over the user `gcloud` login.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function createGcloudTokenProvider(account?: string): () => Promise<string> {
  let cache: { token: string; expiresAt: number } | null = null;

  return async () => {
    if (cache && cache.expiresAt > Date.now()) return cache.token;
    const args = ['auth', 'print-access-token'];
    if (account) args.push('--account', account);
    try {
      const { stdout } = await exec('gcloud', args);
      const token = stdout.trim();
      cache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
      return token;
    } catch (error) {
      throw new Error(
        `Failed to get a gcloud access token (account=${account ?? 'default'}). ` +
          `Is gcloud installed and authenticated? ${(error as Error).message}`,
      );
    }
  };
}
