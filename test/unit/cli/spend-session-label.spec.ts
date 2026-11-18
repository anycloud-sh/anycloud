import { describe, expect, it } from 'vitest';
import { sessionLabeller } from '../../../src/cli/commands/spend.js';

const row = (session: string, user: string | null) => ({
  session,
  agent: null,
  sessionLabel: null,
  user,
});

describe('sessionLabeller', () => {
  it('names the owner once sessions span more than one account', () => {
    const label = sessionLabeller([
      row('sess-a', 'octocat'),
      row('sess-b', 'teammate'),
    ]);

    expect(label(row('sess-a', 'octocat'))).toBe('octocat/sess-a');
    expect(label(row('sess-b', 'teammate'))).toBe('teammate/sess-b');
  });

  it('leaves an unshared API exactly as it was', () => {
    const label = sessionLabeller([
      row('sess-a', 'octocat'),
      row('sess-b', 'octocat'),
    ]);

    expect(label(row('sess-a', 'octocat'))).toBe('sess-a');
  });

  it('prefers the human session label over the raw id', () => {
    const rows = [row('sess-a', 'octocat'), row('sess-b', 'teammate')];
    const label = sessionLabeller(rows);

    expect(
      label({
        session: 'sess-a',
        agent: 'claude',
        sessionLabel: 'pipeline',
        user: 'octocat',
      }),
    ).toBe('octocat/pipeline');
  });

  it('marks an unattributed session rather than dropping the column', () => {
    const label = sessionLabeller([
      row('sess-a', 'octocat'),
      row('sess-b', 'teammate'),
    ]);

    expect(label(row('sess-c', null))).toBe('?/sess-c');
  });
});
