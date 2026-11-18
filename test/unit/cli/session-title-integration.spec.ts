import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectSession } from '../../../src/cli/session/detect';
import {
  sessionTitleAgents,
  writeSessionTitleFixture,
} from '../helpers/agent-session-title';

// Exercise detection with real on-disk readers, including Codex's production
// dispatch. Shared expectations cover the full detect → read → label seam.
describe.each(sessionTitleAgents)(
  '$agent detection with real titles',
  (fixture) => {
    let root: string;
    const id = 'da4330df-741b-4285-ae06-72846a51536b';

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'session-title-int-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const detect = () =>
      detectSession({
        ...fixture.detection(id, root),
        isInteractive: () => false,
      });

    it('surfaces the upstream title through the real reader', () => {
      writeSessionTitleFixture(fixture, root, id, [
        fixture.untitledLine(id),
        fixture.titleLine(id, 'Debug session naming'),
        fixture.untitledLine(id),
      ]);
      expect(detect()).toEqual({
        session: id,
        agent: fixture.agent,
        label: 'Debug session naming',
      });
    });

    it('keeps attribution when the title has not been written', () => {
      writeSessionTitleFixture(fixture, root, id, [fixture.untitledLine(id)]);
      expect(detect()).toEqual({ session: id, agent: fixture.agent });
    });

    it('keeps attribution when the session file is missing', () => {
      expect(detect()).toEqual({ session: id, agent: fixture.agent });
    });

    it('picks up a rename on the next detection', () => {
      writeSessionTitleFixture(fixture, root, id, [
        fixture.titleLine(id, 'First guess'),
      ]);
      expect(detect()?.label).toBe('First guess');
      appendFileSync(
        fixture.file(root, id),
        fixture.titleLine(id, 'Refined title'),
      );
      expect(detect()?.label).toBe('Refined title');
    });

    it('sanitizes the upstream title before applying the label limit', () => {
      writeSessionTitleFixture(fixture, root, id, [
        fixture.titleLine(id, `  A\t${'b'.repeat(100)}\u007f `),
      ]);
      expect(detect()?.label).toBe(`A ${'b'.repeat(62)}`);
    });

    it('omits a title that sanitizes to empty', () => {
      writeSessionTitleFixture(fixture, root, id, [
        fixture.titleLine(id, '\t\n\u0000'),
      ]);
      expect(detect()?.label).toBeUndefined();
    });
  },
);
