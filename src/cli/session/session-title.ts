/**
 * Read the human-readable titles Claude Code and Codex show for sessions.
 *
 * Claude Code stores each session at
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * and the title it displays is resolved, at read time, from two Claude-authored
 * line types in that file — preferring an explicit user rename over the
 * model-generated title:
 *   1. customTitle — latest `{"type":"custom-title","customTitle":…}` (`/rename`)
 *   2. aiTitle     — latest `{"type":"ai-title","aiTitle":…}` (auto, regenerated
 *      as the conversation evolves — we take the latest)
 * This mirrors the official `@anthropic-ai/claude-agent-sdk` resolver for these
 * two fields. We deliberately STOP here: the SDK also falls through to derived
 * sources (lastPrompt / first user prompt), but those would surface noise (e.g.
 * an auth-probe "hi") and force wrapper-stripping of harness-injected prompts,
 * which contradicts "prefer the upstream-generated name; don't derive". When
 * neither title exists we return null and the caller falls back to the plain
 * `agent:session` display.
 *
 * Codex appends {id, thread_name, updated_at} records to
 * $CODEX_HOME/session_index.jsonl (default ~/.codex). The latest matching
 * thread_name is its display title, including explicit renames.
 *
 * This is the one place coupled to the agents' on-disk title formats.
 * It is strictly best-effort: any failure — no file, no title yet,
 * unreadable, malformed JSON — returns null. It never throws and never blocks a
 * submit.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Session ids are UUIDs; refuse anything that could escape the projects dir.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Replace control chars with spaces, collapse whitespace, trim. Empty -> null. */
function sanitize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const cleaned = out.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Find `<sessionId>.jsonl` under any project dir. The session id is globally
 * unique, so scanning by filename avoids depending on Claude's cwd→dir
 * encoding.
 */
function findTranscript(sessionId: string, projectsDir: string): string | null {
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Latest value of a top-level string field across matching records.
 * "Latest" = nearest the end of file (most recent), matching Claude's take-last
 * semantics. Scans from the end and stops at the first match, so it usually
 * reads only a handful of tail lines. Returns the raw value; the caller
 * sanitizes once. Matches a top-level type or thread id, so titles inside a
 * tool-result payload or belonging to another thread cannot leak.
 */
function latestField(
  lines: string[],
  matchField: string,
  matchValue: string,
  field: string,
): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(`"${field}"`)) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed?.[matchField] === matchValue) {
        const value = parsed[field];
        if (typeof value === 'string' && value.length > 0) return value;
      }
    } catch {
      // Skip a malformed line and keep scanning earlier ones.
    }
  }
  return null;
}

export interface ReadSessionTitleOptions {
  /** Override the projects-dir root (tests only). */
  projectsDir?: string;
}

/**
 * The title Claude Code displays for a session (custom rename, else auto
 * ai-title), or null when neither exists. Best-effort; never throws.
 */
export function readClaudeSessionTitle(
  sessionId: string,
  opts: ReadSessionTitleOptions = {},
): string | null {
  try {
    if (!SAFE_ID.test(sessionId)) return null;
    const file = findTranscript(sessionId, opts.projectsDir ?? PROJECTS_DIR);
    if (!file) return null;
    const lines = readFileSync(file, 'utf8').split('\n');
    const resolved =
      latestField(lines, 'type', 'custom-title', 'customTitle') ??
      latestField(lines, 'type', 'ai-title', 'aiTitle');
    return sanitize(resolved);
  } catch {
    return null;
  }
}

export interface ReadCodexSessionTitleOptions {
  /** Override the Codex home; otherwise use CODEX_HOME or ~/.codex. */
  codexHome?: string;
}

/** Latest Codex thread name from its index. Best-effort; never throws. */
export function readCodexSessionTitle(
  sessionId: string,
  opts: ReadCodexSessionTitleOptions = {},
): string | null {
  try {
    if (!SAFE_ID.test(sessionId)) return null;
    const codexHome =
      opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
    const lines = readFileSync(
      join(codexHome, 'session_index.jsonl'),
      'utf8',
    ).split('\n');
    return sanitize(latestField(lines, 'id', sessionId, 'thread_name'));
  } catch {
    return null;
  }
}
