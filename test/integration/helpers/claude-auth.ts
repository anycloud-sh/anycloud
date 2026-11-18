/** Isolate metadata commands from credentials, settings, and parent agent ids. */
export function claudeMetadataEnvironment(
  env: NodeJS.ProcessEnv,
  configDir: string,
): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    SHELL: env.SHELL,
    LANG: env.LANG,
    TMPDIR: env.TMPDIR,
    USER: env.USER,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

/** Select credentials for live title generation without changing the parent environment. */
export function claudeCanaryEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();

  if (env.CI && !apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for the Claude session-title canary in CI. Configure the repository Actions secret.',
    );
  }
  if (!apiKey && !oauthToken && env.RUN_CLAUDE_E2E !== '1') {
    throw new Error(
      'Claude authentication not found. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or RUN_CLAUDE_E2E=1 to use the machine login.',
    );
  }

  const childEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  if (apiKey) {
    childEnv.ANTHROPIC_API_KEY = apiKey;
  } else if (oauthToken) {
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  return childEnv;
}
