import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateJobId } from '../../../src/shared/id-generator.js';

const crypto = vi.hoisted(() => ({
  randomBytes: vi.fn(),
  real: undefined as unknown as (size: number) => Buffer,
}));
const { randomBytes } = crypto;
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  crypto.real = actual.randomBytes;
  crypto.randomBytes.mockImplementation(crypto.real);
  return { ...actual, randomBytes: crypto.randomBytes };
});

/** Queue the next randomBytes results, one byte array per call. */
function queueBytes(...calls: number[][]) {
  for (const bytes of calls) {
    randomBytes.mockReturnValueOnce(Buffer.from(bytes));
  }
}

describe('ID Generator', () => {
  describe('generateJobId', () => {
    // Each test gets its own millisecond so suffixes issued by one test never
    // count as repeats in the next.
    let testMs = Date.parse('2024-12-03T14:22:35.000Z');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(testMs);
      testMs += 1000;
    });

    afterEach(() => {
      vi.useRealTimers();
      randomBytes.mockReset();
      randomBytes.mockImplementation(crypto.real);
    });

    it('uses "job" prefix when no image provided', () => {
      const id = generateJobId();
      expect(id).toMatch(/^job-\d+-[a-z0-9]+$/);
    });

    it('extracts image name from simple image', () => {
      const id = generateJobId('myapp');
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('extracts image name from image with tag', () => {
      const id = generateJobId('myapp:latest');
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('extracts image name from image with registry', () => {
      const id = generateJobId('ghcr.io/user/myapp:latest');
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('extracts image name from image with digest', () => {
      const id = generateJobId('myapp@sha256:abc123');
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('extracts image name from complex registry path', () => {
      const id = generateJobId(
        'registry.example.com:5000/org/team/myapp:v1.2.3',
      );
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('sanitizes special characters from image name', () => {
      const id = generateJobId('my_app.test:latest');
      expect(id).toMatch(/^myapptest-\d+-[a-z0-9]+$/);
    });

    it('truncates long image names so the full ID stays within validateId cap', () => {
      const id = generateJobId(
        'this-is-a-very-long-image-name-that-exceeds-limit:latest',
      );
      expect(id.length).toBeLessThanOrEqual(28);
      const prefix = id.replace(/-\d+-[a-z0-9]+$/, '');
      expect(prefix.length).toBeLessThanOrEqual(9);
    });

    it('strips trailing hyphens from image name after sanitization', () => {
      // An image name that ends with non-alphanumeric chars, leaving a trailing hyphen after sanitization
      const id = generateJobId('myapp-_:latest');
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('collapses hyphen runs so the ID is a valid Azure container name', () => {
      const id = generateJobId('my--a_-pp:latest');
      expect(id).toMatch(/^my-a-pp-\d+-[a-z0-9]+$/);
    });

    it('strips trailing hyphens from truncated image name', () => {
      // After truncation, the name might end with a hyphen
      const id = generateJobId('this-is-a-very-long-image-name:latest');
      const prefix = id.replace(/-\d+-[a-z0-9]+$/, '');
      expect(prefix).not.toMatch(/-$/);
    });

    it('converts image name to lowercase', () => {
      const id = generateJobId('MyApp:Latest');
      expect(id).toMatch(/^myapp-\d+-[a-z0-9]+$/);
    });

    it('includes timestamp for uniqueness', () => {
      const id = generateJobId('myapp');
      expect(id).toContain(String(Date.now()));
    });

    it('redraws a suffix already issued in the same millisecond', () => {
      queueBytes([10, 11, 12, 13], [10, 11, 12, 13], [14, 15, 16, 17]);

      expect(generateJobId('myapp')).toBe(`myapp-${Date.now()}-abcd`);
      expect(generateJobId('myapp')).toBe(`myapp-${Date.now()}-efgh`);
    });

    it('rejects bytes that would bias the base36 suffix', () => {
      // 252-255 would map to 0-3 again; 251 is the last unbiased byte (z).
      queueBytes([252, 0, 255, 251], [253, 1], [2]);

      expect(generateJobId('myapp')).toBe(`myapp-${Date.now()}-0z12`);
    });

    it('allows a suffix again once the millisecond changes', () => {
      queueBytes([20, 21, 22, 23], [20, 21, 22, 23]);
      expect(generateJobId('myapp')).toBe(`myapp-${Date.now()}-klmn`);
      vi.advanceTimersByTime(1);

      expect(generateJobId('myapp')).toBe(`myapp-${Date.now()}-klmn`);
    });
  });
});
