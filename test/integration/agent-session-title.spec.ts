import { describe, it, expect } from 'vitest';
import {
  createClaudeTitleSession,
  createCodexTitleSession,
} from './helpers/agent-session-title';

// Real-CLI drift canary. Fixtures test our parsers; this suite also catches
// upstream title-format changes. Select one agent with -t '^claude ' or
// -t '^codex '. Only the Claude generated-title case uses authentication.
const agents = [
  {
    agent: 'claude',
    create: createClaudeTitleSession,
    cases: [
      { behavior: 'named title', names: ['anycloud named session'] },
      {
        behavior: 'renamed title',
        names: ['anycloud initial session', 'anycloud renamed session'],
      },
    ],
  },
  {
    agent: 'codex',
    create: createCodexTitleSession,
    cases: [
      { behavior: 'named title', names: ['anycloud named session'] },
      {
        behavior: 'renamed title',
        names: ['anycloud initial session', 'anycloud renamed session'],
      },
    ],
  },
];

describe.each(agents.map((adapter) => [adapter.agent, adapter] as const))(
  '%s session titles',
  (_agent, { create, cases }) => {
    it.each(cases.map(({ behavior, names }) => [behavior, names] as const))(
      'reads the %s and preserves it after process exit',
      async (_behavior, names) => {
        const session = await create();
        try {
          for (const name of names) {
            await session.setName(name);
            expect(session.readTitle()).toBe(name);
          }
          await session.finish();
          expect(session.readTitle()).toBe(names.at(-1));
          expect.assertions(names.length + 1);
        } finally {
          await session.cleanup();
        }
      },
      135_000,
    );
  },
);

describe('claude session titles', () => {
  it('reflects the generated title recorded by Claude', async () => {
    const session = createClaudeTitleSession('generated');
    try {
      await session.run();
      const generated = session.generatedTitle();
      // Claude may omit its background title in print mode. The reader must
      // match the independent transcript oracle, including a missing title.
      expect(session.readTitle()).toBe(generated);
    } finally {
      await session.cleanup();
    }
  }, 135_000);
});

describe('codex session titles', () => {
  it('exposes the native thread id to child commands', async () => {
    const session = await createCodexTitleSession();
    try {
      expect(await session.childThreadId()).toBe(session.sessionId);
      await session.finish();
    } finally {
      await session.cleanup();
    }
  }, 90_000);
});
