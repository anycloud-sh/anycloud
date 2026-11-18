import { describe, expect, it } from 'vitest';
import {
  API_NOTIFICATION_LABEL_ENV,
  configuredApiNotificationLabel,
  hostedApiNotificationLabel,
  localApiNotificationLabel,
} from '../../../src/shared/notifications/source.js';

describe('notification source labels', () => {
  it('derives a local label from the starting user and host', () => {
    expect(
      localApiNotificationLabel({
        username: 'alice',
        hostname: 'workstation',
        port: 8080,
        defaultPort: 8080,
      }),
    ).toBe('alice@workstation');
  });

  it('adds a non-default local port and falls back when the user is absent', () => {
    expect(
      localApiNotificationLabel({
        username: undefined,
        hostname: 'workstation',
        port: 8081,
        defaultPort: 8080,
      }),
    ).toBe('workstation:8081');
  });

  it('uses a configured local override verbatim after whitespace cleanup', () => {
    expect(
      localApiNotificationLabel({
        username: 'alice',
        hostname: 'workstation',
        port: 8081,
        defaultPort: 8080,
        override: '  Research   API  ',
      }),
    ).toBe('Research API');
  });

  it('formats hosted workload and owner metadata', () => {
    expect(hostedApiNotificationLabel('production', '@octocat')).toBe(
      'production.anycloud.sh · @octocat',
    );
  });

  it('reads the runtime label from the dedicated environment variable', () => {
    expect(
      configuredApiNotificationLabel({
        [API_NOTIFICATION_LABEL_ENV]: ' alice@workstation ',
      }),
    ).toBe('alice@workstation');
    expect(configuredApiNotificationLabel({})).toBeUndefined();
  });
});
