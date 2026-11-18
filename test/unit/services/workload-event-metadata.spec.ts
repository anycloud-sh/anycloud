import { describe, expect, it } from 'vitest';
import { decodeWorkloadEventMetadata } from '../../../src/api/services/workload-event-metadata.js';

describe('decodeWorkloadEventMetadata', () => {
  it('decodes object metadata', () => {
    expect(decodeWorkloadEventMetadata('{"reason":"resubmitted"}')).toEqual({
      reason: 'resubmitted',
    });
  });

  it.each([undefined, null, '', 'not valid json', 'null', '[]', '"text"'])(
    'maps absent or non-object metadata to null: %j',
    (raw) => {
      expect(decodeWorkloadEventMetadata(raw)).toBeNull();
    },
  );
});
