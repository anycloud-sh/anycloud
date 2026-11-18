export interface SessionDisplayInput {
  session: string | null;
  agent: string | null;
  sessionLabel: string | null;
}

/**
 * Prefer a human-readable label, then a compact agent/session identity, then
 * the raw session id. Returns null when there is no session to display.
 */
export function formatSessionDisplay(
  input: SessionDisplayInput,
): string | null {
  if (input.sessionLabel) return input.sessionLabel;
  if (!input.session) return null;
  if (input.agent && input.session.length > 12) {
    return `${input.agent}:${input.session.slice(0, 6)}`;
  }
  return input.session;
}
