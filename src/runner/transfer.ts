import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

/** A copy that moves nothing for this long is stopped (RFC 0043). */
export const NO_PROGRESS_MS = 15 * 60_000;

export interface CopyResult {
  /** `missing`: rclone's "directory not found" (exit 3). */
  result: 'done' | 'missing' | 'denied' | 'failed' | 'stalled';
  detail: string;
  /** Whether rclone checked or moved anything before it ended. */
  moved: boolean;
}

/**
 * `rclone copy` between a local path and a remote, which never deletes, or
 * with `sync`, a download that also removes local files the remote lacks.
 */
export type Copy = (
  from: string,
  to: string,
  env: Record<string, string>,
  sync?: boolean,
) => Promise<CopyResult>;

const DENIED =
  /AuthorizationFailure|AuthenticationFailed|AuthorizationPermissionMismatch|AccessDenied|\b403\b/;
/**
 * A grant that lapsed during the copy (RFC 0043): GCS fails locally, and
 * fatally (exit 7), on a token past its `expiry`; S3 answers `ExpiredToken`.
 * The renewed grant the runner holds fixes it, so it is `failed`, not `denied`.
 */
const EXPIRED = /token expired|ExpiredToken/;

/** SAS and presigned query strings stay out of reports and logs. */
const redact = (line: string) => line.replace(/\?[^\s"']*/g, '?…');

/**
 * Run one copy with the VM sync's flags. Progress is any growth in the bytes
 * or files rclone has checked or moved; a copy with none for `stallMs` is
 * killed and reported `stalled`. Credentials reach rclone only in its env,
 * with the CA bundle shipped beside it, since a Job image may have none.
 */
export function rcloneCopy(rclone: string, stallMs = NO_PROGRESS_MS): Copy {
  return (from, to, env, sync = false) =>
    new Promise((resolve) => {
      const child = spawn(
        rclone,
        [
          sync ? 'sync' : 'copy',
          from,
          to,
          '--fast-list',
          '--no-update-modtime',
          '--modify-window',
          '1s',
          '--use-json-log',
          '--stats',
          '10s',
          // rclone logs stats at INFO; NOTICE prints them without -v.
          '--stats-log-level',
          'NOTICE',
        ],
        {
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            SSL_CERT_FILE: join(dirname(rclone), 'ca-certificates.crt'),
            ...env,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let moved = 0;
      let stalled = false;
      let detail = '';
      let expired = false;
      let watchdog = setTimeout(stall, stallMs);
      function stall() {
        stalled = true;
        child.kill('SIGKILL');
      }
      createInterface({ input: child.stderr }).on('line', (line) => {
        try {
          const entry = JSON.parse(line) as {
            level?: string;
            msg?: string;
            stats?: { bytes?: number; checks?: number; transfers?: number };
          };
          const { bytes = 0, checks = 0, transfers = 0 } = entry.stats ?? {};
          if (bytes + checks + transfers > moved) {
            moved = bytes + checks + transfers;
            clearTimeout(watchdog);
            watchdog = setTimeout(stall, stallMs);
          }
          if (entry.level === 'error' && entry.msg) detail = redact(entry.msg);
        } catch {
          detail = redact(line);
        }
        expired ||= EXPIRED.test(line);
      });
      child.on('error', (error) => {
        clearTimeout(watchdog);
        resolve({ result: 'failed', detail: error.message, moved: false });
      });
      child.on('close', (code) => {
        clearTimeout(watchdog);
        const text = detail.slice(0, 500) || `rclone exited with code ${code}`;
        resolve({
          result: stalled
            ? 'stalled'
            : code === 0
              ? 'done'
              : code === 3
                ? 'missing'
                : !expired && (code === 7 || DENIED.test(detail))
                  ? 'denied'
                  : 'failed',
          detail: stalled ? `no progress for ${stallMs / 60_000} min` : text,
          moved: moved > 0,
        });
      });
    });
}
