import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Stands in for what `anycloud api start` writes: a CLI or SDK pointed at a
 * loopback API sends the token in its ANYCLOUD_DIR. The default suits
 * in-process APIs, which authenticate the GitHub stub and take any bearer but
 * a real local token's shape.
 */
export function writeLocalApiToken(
  anycloudDir: string,
  token = 'in-process-api',
): void {
  mkdirSync(anycloudDir, { recursive: true });
  writeFileSync(path.join(anycloudDir, 'local-api-token'), token, {
    mode: 0o600,
  });
}
