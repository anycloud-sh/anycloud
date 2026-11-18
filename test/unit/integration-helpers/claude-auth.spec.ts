import { describe, expect, it } from 'vitest';
import {
  claudeCanaryEnvironment,
  claudeMetadataEnvironment,
} from '../../integration/helpers/claude-auth';

describe('Claude metadata environment', () => {
  it('keeps execution essentials while isolating credentials, configuration, and parent ids', () => {
    const env = Object.freeze({
      PATH: '/usr/bin',
      SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      USER: 'runner',
      CI: 'true',
      CLAUDE_CONFIG_DIR: '/real/claude',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-claude',
      CODEX_THREAD_ID: 'parent-codex',
      ANTHROPIC_API_KEY: 'api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      ANTHROPIC_BASE_URL: 'https://parent-provider.example',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      RUN_CLAUDE_E2E: '1',
    });

    expect(claudeMetadataEnvironment(env, '/temporary/claude')).toEqual({
      PATH: '/usr/bin',
      SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      USER: 'runner',
      CLAUDE_CONFIG_DIR: '/temporary/claude',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/real/claude');
    expect(env.ANTHROPIC_API_KEY).toBe('api-key');
  });
});

describe('Claude canary authentication', () => {
  it('passes an API key in its own variable in CI', () => {
    const env = {
      CI: 'true',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'ci-api-key',
    };

    expect(claudeCanaryEnvironment(env)).toEqual(env);
    expect(claudeCanaryEnvironment(env)).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('preserves local OAuth authentication without creating an API key', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'local-oauth-token' };

    expect(claudeCanaryEnvironment(env)).toEqual(env);
    expect(claudeCanaryEnvironment(env)).not.toHaveProperty(
      'ANTHROPIC_API_KEY',
    );
  });

  it('prefers the API key and removes OAuth only from the child environment', () => {
    const env = Object.freeze({
      ANTHROPIC_API_KEY: 'api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'disabled-subscription-token',
      PATH: '/usr/bin',
    });

    expect(claudeCanaryEnvironment(env)).toEqual({
      ANTHROPIC_API_KEY: 'api-key',
      PATH: '/usr/bin',
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('disabled-subscription-token');
  });

  it.each([undefined, '', ' \t\n'])(
    'accepts an API key with an absent or empty OAuth token (%j)',
    (oauthToken) => {
      expect(
        claudeCanaryEnvironment({
          ANTHROPIC_API_KEY: 'api-key',
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        }),
      ).toEqual({ ANTHROPIC_API_KEY: 'api-key' });
    },
  );

  it.each([undefined, '', ' \t\n'])(
    'requires the CI API key even when OAuth and local opt-in are present (%j)',
    (apiKey) => {
      expect(() =>
        claudeCanaryEnvironment({
          CI: 'true',
          ANTHROPIC_API_KEY: apiKey,
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
          RUN_CLAUDE_E2E: '1',
        }),
      ).toThrow('ANTHROPIC_API_KEY is required');
    },
  );

  it('ignores an empty API key when using a local OAuth token', () => {
    expect(
      claudeCanaryEnvironment({
        ANTHROPIC_API_KEY: ' ',
        CLAUDE_CODE_OAUTH_TOKEN: 'local-oauth-token',
      }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'local-oauth-token' });
  });

  it('requires explicit opt-in before using machine login', () => {
    expect(() => claudeCanaryEnvironment({})).toThrow(
      'RUN_CLAUDE_E2E=1 to use the machine login',
    );
    expect(() => claudeCanaryEnvironment({ RUN_CLAUDE_E2E: '0' })).toThrow(
      'Claude authentication not found',
    );
  });

  it('uses machine login without injecting credentials when opted in locally', () => {
    expect(
      claudeCanaryEnvironment({
        RUN_CLAUDE_E2E: '1',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: ' ',
        PATH: '/usr/bin',
      }),
    ).toEqual({ RUN_CLAUDE_E2E: '1', PATH: '/usr/bin' });
  });
});
