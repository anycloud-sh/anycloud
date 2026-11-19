import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOwnApiImage } from '../../../../src/api/config.js';

const chart = (path: string) =>
  readFileSync(
    new URL(`../../../../charts/anycloud-api/${path}`, import.meta.url),
    'utf8',
  );

describe('the API chart’s self-delete values (RFC 0049 C26 (e))', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands the API container the release values’ selfDelete as JSON, only when set', () => {
    const api = chart('templates/api.yaml');
    const block = api.slice(
      api.indexOf('{{- if .Values.selfDelete }}'),
      api.indexOf('{{- end }}', api.indexOf('{{- if .Values.selfDelete }}')),
    );
    expect(block).toContain('- name: ANYCLOUD_SELF_DELETE');
    expect(block).toContain('value: {{ toJson .Values.selfDelete | quote }}');
    // In the API container, not the restore init container.
    expect(api.indexOf('ANYCLOUD_SELF_DELETE')).toBeGreaterThan(
      api.indexOf('- name: api\n'),
    );
    expect(chart('values.yaml')).toMatch(/^selfDelete: null$/m);
  });

  it('mounts the e2e access kubeconfig and names it to the API only when e2eAccess is set', () => {
    const api = chart('templates/api.yaml');
    const blocks = api.split('{{- if .Values.e2eAccess }}').slice(1);
    expect(blocks).toHaveLength(3);
    expect(blocks.join('')).toContain('value: /mnt/e2e-access/kubeconfig');
    expect(blocks.join('')).toContain('path: /var/lib/anycloud/e2e-access');
    expect(chart('values.yaml')).toMatch(/^e2eAccess: false$/m);
  });

  it('names the listed GitHub Apps to the API process only when there are any', () => {
    const api = chart('templates/api.yaml');
    const start = api.indexOf('{{- with .Values.installation.githubAppIds }}');
    expect(start).toBeGreaterThan(api.indexOf('- --hosted-api-owner-id'));
    expect(api.slice(start, api.indexOf('{{- end }}', start))).toContain(
      '- --hosted-api-github-apps\n            - {{ join "," . | quote }}',
    );
    expect(chart('values.yaml')).toMatch(/^ {2}githubAppIds: \[\]$/m);
  });

  it('names the digest-pinned release image to the API container', () => {
    const api = chart('templates/api.yaml');
    const env = api.indexOf('- name: ANYCLOUD_RELEASE_IMAGE');
    expect(env).toBeGreaterThan(api.indexOf('- name: api\n'));
    expect(api.slice(env, env + 120)).toContain(
      'value: {{ .Values.release.image | quote }}',
    );
  });

  it("reports only a digest-pinned image as the API's own", () => {
    const pinned = `ghcr.io/anycloud-sh/api:0.1.74@sha256:${'e'.repeat(64)}`;
    vi.stubEnv('ANYCLOUD_RELEASE_IMAGE', pinned);
    expect(getOwnApiImage()).toBe(pinned);
    vi.stubEnv('ANYCLOUD_RELEASE_IMAGE', 'ghcr.io/anycloud-sh/api:0.1.74');
    expect(getOwnApiImage()).toBeNull();
    vi.stubEnv('ANYCLOUD_RELEASE_IMAGE', '');
    expect(getOwnApiImage()).toBeNull();
  });
});
