import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const phase = 'http_config_settings';
const ref = 'anycloud_agent_documentation_bic';
const expression =
  '(http.host eq "anycloud.sh" and http.request.method in {"GET" "HEAD"} and (http.request.uri.path in {"/SKILL.md" "/llms.txt" "/llms-full.txt"} or ends_with(http.request.uri.path, ".md")))';
interface Rule {
  id: string;
  ref?: string;
  expression: string;
  action: string;
  action_parameters?: { bic?: boolean };
  enabled?: boolean;
}
interface Ruleset {
  id: string;
  rules?: Rule[];
}
interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: unknown[];
}

async function main() {
  const [operation, ...extra] = process.argv.slice(2);
  if (!['inspect', 'apply'].includes(operation) || extra.length) {
    throw new Error('Use inspect or apply through spike.yml.');
  }
  if (
    !process.env.GITHUB_ACTIONS ||
    !process.env.SPIKE_OUTPUT_DIR ||
    !process.env.CLOUDFLARE_API_TOKEN
  ) {
    throw new Error('Requires spike.yml and its Cloudflare token.');
  }
  const output = process.env.SPIKE_OUTPUT_DIR;
  mkdirSync(output, { recursive: true });
  const save = (name: string, value: unknown) =>
    writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  const requests: unknown[] = [];
  async function api<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    allowMissing = false,
  ): Promise<T | undefined> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const envelope = (await response.json()) as Envelope<T>;
    requests.push({
      path,
      method,
      status: response.status,
      errors: envelope.errors,
    });
    save('requests.json', requests);
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok || !envelope.success)
      throw new Error(
        `${method} ${path}: HTTP ${response.status}; ${JSON.stringify(envelope.errors)}`,
      );
    return envelope.result;
  }
  const zones = await api<Array<{ id: string; name: string }>>(
    '/zones?name=anycloud.sh',
  );
  if (zones?.length !== 1 || zones[0].name !== 'anycloud.sh')
    throw new Error('Expected exactly the anycloud.sh zone.');
  const zone = zones[0].id;
  const setting = await api(`/zones/${zone}/settings/browser_check`);
  save('browser-integrity-check.json', setting);
  const endpoint = `/zones/${zone}/rulesets/phases/${phase}/entrypoint`;
  const before = await api<Ruleset>(endpoint, 'GET', undefined, true);
  save('rules-before.json', before ?? null);
  const rule = {
    ref,
    description:
      'Allow generic HTTP clients to read public agent documentation',
    expression,
    action: 'set_config',
    action_parameters: { bic: false },
    enabled: true,
  };
  save('proposed-rule.json', rule);
  if (operation === 'inspect') {
    console.log('Zone and current configuration inspected; no mutation.');
    return;
  }
  const existing = before?.rules?.find((candidate) => candidate.ref === ref);
  if (
    existing &&
    (existing.expression !== expression ||
      existing.action !== rule.action ||
      existing.action_parameters?.bic !== false ||
      existing.enabled === false)
  ) {
    throw new Error(
      'Owned rule differs from the proposed scope; refusing to overwrite it.',
    );
  }
  if (!existing) {
    if (before) {
      await api(`/zones/${zone}/rulesets/${before.id}/rules`, 'POST', rule);
    } else {
      await api(`/zones/${zone}/rulesets`, 'POST', {
        name: 'Anycloud configuration',
        kind: 'zone',
        phase,
        rules: [rule],
      });
    }
  }
  const after = await api<Ruleset>(endpoint);
  save('rules-after.json', after);
  const installed = after?.rules?.find((candidate) => candidate.ref === ref);
  if (
    !installed ||
    installed.expression !== expression ||
    installed.action_parameters?.bic !== false
  )
    throw new Error('Rule verification failed.');
  save('applied-rule.json', {
    zone,
    ruleset: after?.id,
    rule: installed.id,
    created: !existing,
  });
  const afterSetting = await api(`/zones/${zone}/settings/browser_check`);
  if (JSON.stringify(setting) !== JSON.stringify(afterSetting))
    throw new Error(
      'Global Browser Integrity Check setting changed during the experiment.',
    );
  const resources = ['/SKILL.md', '/llms.txt', '/getting-started.md'];
  for (let attempt = 0; attempt < 10; attempt++) {
    const results = [];
    for (const resource of resources) {
      const response = await fetch(`https://anycloud.sh${resource}`, {
        signal: AbortSignal.timeout(30_000),
      });
      let python = false;
      try {
        const text = execFileSync(
          'python3',
          [
            '-c',
            'import urllib.request,sys; r=urllib.request.urlopen(sys.argv[1],timeout=25); print(r.status); print(r.read().decode())',
            `https://anycloud.sh${resource}`,
          ],
          {
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        python = text.startsWith('200\n') && text.includes('anycloud');
      } catch {
        python = false;
      }
      results.push({
        resource,
        node:
          response.status === 200 &&
          (await response.text()).includes('anycloud'),
        python,
      });
    }
    save('client-access.json', { attempt: attempt + 1, results });
    if (results.every((result) => result.node && result.python)) {
      console.log(
        'Scoped rule verified; Node fetch and Python urllib retrieve all three documentation resources.',
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(
    'Rule persisted, but generic client access still fails; inspect retained evidence before another change.',
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Documentation access experiment failed.',
  );
  process.exitCode = 1;
});
