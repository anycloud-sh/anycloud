/**
 * Auto-detect the agent that invoked the CLI, so submits get attributed
 * without per-launcher configuration.
 *
 * Resolution:
 *   1. Agent marker env (CLAUDECODE / CODEX_THREAD_ID / CODEX_BIN_PATH /
 *      CURSOR_TRACE_ID / AIDER_MODEL).
 *      When the agent also exposes a stable session id env, we use it raw —
 *      makes anycloud rows joinable against the agent's own logs.
 *      Otherwise we synthesize `<agent>-<ppid>` from the calling process.
 *   2. None (untagged submit).
 *
 * A TTY guard suppresses auto-detect whenever a human is plausibly present —
 * i.e. when EITHER stdin or stdout is a terminal. This covers a human who runs
 * the CLI from a shell opened inside an agent (so the agent's marker env is
 * inherited) and pipes or redirects the output (`anycloud list | head`); only a
 * fully non-TTY, programmatic invocation is treated as an agent run.
 *
 * Anycloud does not interpret these values — caps, identity issuance, and
 * cross-tool joins all live in a layer above. See migration 0047.
 */

import {
  readClaudeSessionTitle,
  readCodexSessionTitle,
} from './session-title.js';

const MAX_LEN = 64;

interface AgentEntry {
  /** Stamped into `workloads.agent`. */
  name: string;
  /** Presence of this env var means the agent is the invoker. */
  markerEnv: string;
  /** Agent-native session id env, when one exists. Preferred over ppid. */
  sessionEnv?: string;
}

const AGENTS: AgentEntry[] = [
  {
    name: 'claude',
    markerEnv: 'CLAUDECODE',
    sessionEnv: 'CLAUDE_CODE_SESSION_ID',
  },
  {
    name: 'codex',
    markerEnv: 'CODEX_BIN_PATH',
    sessionEnv: 'CODEX_THREAD_ID',
  },
  {
    name: 'cursor',
    markerEnv: 'CURSOR_TRACE_ID',
    sessionEnv: 'CURSOR_TRACE_ID',
  },
  { name: 'aider', markerEnv: 'AIDER_MODEL' },
];

export interface DetectedSession {
  session: string;
  agent: string | null;
  /** Human-readable display label from the agent's session title, when available. */
  label?: string;
}

export interface SessionScope {
  session?: string;
  agent?: string;
  /**
   * True when the scope was auto-derived from the caller's own session — i.e.
   * an agent ran a read command without explicit --session/--agent. Lets
   * callers surface a "scoped to your session" hint.
   */
  autoScoped: boolean;
}

export interface SessionScopeOptions {
  session?: string;
  agent?: string;
}

/**
 * Resolve the workload scope for read commands (list, cost). Agents invoking
 * the CLI non-interactively are pinned to *their own session*, so parallel
 * agents don't see each other's workloads. Precedence:
 *   1. explicit --session / --agent  → that filter (autoScoped=false)
 *   2. a detected agent session       → that session (autoScoped=true)
 *   3. interactive human / untagged   → no scope (autoScoped=false)
 *
 * Interactive (TTY) runs are never scoped — detectSession() returns null — so a
 * human at a terminal always sees every session.
 */
export function resolveSessionScope(
  opts: SessionScopeOptions,
  detect: () => DetectedSession | null = detectSession,
): SessionScope {
  if (opts.session || opts.agent) {
    return { session: opts.session, agent: opts.agent, autoScoped: false };
  }
  const detected = detect();
  if (detected) return { session: detected.session, autoScoped: true };
  return { autoScoped: false };
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  ppid?: number;
  isInteractive?: () => boolean;
  /** Read a supported agent's display title by id. Injected in tests. */
  readTitle?: (sessionId: string) => string | null;
}

function clamp(s: string): string {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
}

function defaultIsInteractive(): boolean {
  // A terminal on EITHER stream means a human is present (typing at the keyboard
  // or watching the terminal), even if they piped/redirected the other stream —
  // e.g. `anycloud list | head` from a shell that inherited an agent's marker
  // env. We only treat a run as a genuine agent invocation when NEITHER stream
  // is a TTY (a fully programmatic pipe context). Using && here would mis-tag
  // every piped/redirected human command as an agent and silently scope/attribute it.
  return Boolean(process.stdin.isTTY || process.stdout.isTTY);
}

/**
 * Env an agent sets when it runs the CLI, even in a terminal. Cursor's
 * integrated terminals inherit CURSOR_TRACE_ID, humans run Aider, and Codex
 * sets CODEX_THREAD_ID for its commands, so CURSOR_TRACE_ID, AIDER_MODEL and
 * CODEX_BIN_PATH only attribute workloads (AGENTS above).
 */
export const UNATTENDED_MARKERS = [
  'CLAUDECODE',
  'CODEX_THREAD_ID',
  'CURSOR_AGENT',
];

/**
 * Nobody can answer a prompt: an agent runs the CLI or stdout isn't a
 * terminal. Sign-in then relays the human's part instead of waiting.
 */
export function isUnattended(): boolean {
  return (
    !process.stdout.isTTY ||
    UNATTENDED_MARKERS.some((name) => process.env[name])
  );
}

export function detectSession(
  opts: DetectOptions = {},
): DetectedSession | null {
  const env = opts.env ?? process.env;

  const isInteractive = opts.isInteractive ?? defaultIsInteractive;
  if (isInteractive()) return null;

  for (const agent of AGENTS) {
    const nativeSession = agent.sessionEnv
      ? env[agent.sessionEnv]?.trim()
      : undefined;
    if (!env[agent.markerEnv] && !(agent.name === 'codex' && nativeSession)) {
      continue;
    }
    const session = clamp(
      nativeSession
        ? nativeSession
        : `${agent.name}-${opts.ppid ?? process.ppid}`,
    );
    // Legacy Codex process-based IDs cannot be looked up in its thread index.
    let rawTitle: string | null = null;
    if (agent.name === 'claude') {
      rawTitle = (opts.readTitle ?? readClaudeSessionTitle)(session);
    } else if (agent.name === 'codex' && nativeSession) {
      rawTitle = opts.readTitle
        ? opts.readTitle(session)
        : readCodexSessionTitle(session, { codexHome: env.CODEX_HOME });
    }
    const label = rawTitle ? clamp(rawTitle) : undefined;
    return { session, agent: agent.name, label };
  }

  return null;
}
