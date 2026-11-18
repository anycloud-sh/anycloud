import { describe, it, expect } from 'vitest';
import { quotaCodeFor } from '../../../src/api/services/quota/aws.js';

describe('AWS quotaCodeFor', () => {
  it('maps G-family on-demand and spot', () => {
    expect(quotaCodeFor('g6e.48xlarge', false)).toBe('L-DB2E81BA');
    expect(quotaCodeFor('g6e.48xlarge', true)).toBe('L-3819A6DF');
  });

  it('maps P-family on-demand and spot', () => {
    expect(quotaCodeFor('p5.48xlarge', false)).toBe('L-417A185B');
    expect(quotaCodeFor('p5.48xlarge', true)).toBe('L-7212CCBC');
  });

  it('maps Trainium and Inferentia', () => {
    expect(quotaCodeFor('trn1.32xlarge', false)).toBe('L-2C3B7624');
    expect(quotaCodeFor('inf2.48xlarge', false)).toBe('L-1945791B');
  });

  it('falls back to Standard for unknown prefixes', () => {
    expect(quotaCodeFor('m7i.2xlarge', false)).toBe('L-1216C47A');
    expect(quotaCodeFor('c7i.2xlarge', true)).toBe('L-34B43A08');
  });
});
