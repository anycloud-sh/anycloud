#!/usr/bin/env tsx
/**
 * Live feasibility experiment for RFC 0015's Lambda resource-network adapter.
 *
 * The experiment intentionally calls Lambda's public API directly. Its purpose
 * is to establish provider facts before adding a production capability.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const API_BASE = 'https://cloud.lambda.ai/api/v1';
const DEFAULT_VM_TYPE = 'gpu_1x_a10';
const IMAGE_FAMILY = 'lambda-stack-24-04';
const SSH_PORT = 22;
const RAW_TCP_PORT = 36_443;
const KUBELET_PORT = 10_250;
const FLANNEL_PORT = 8_472;
const GENERAL_REQUEST_INTERVAL_MS = 1_100;
const LAUNCH_REQUEST_INTERVAL_MS = 12_500;
const API_TIMEOUT_MS = 30_000;
const ACTIVE_TIMEOUT_MS = 15 * 60_000;
const SSH_TIMEOUT_MS = 10 * 60_000;
const NETWORK_CONVERGENCE_TIMEOUT_MS = 90_000;
const TERMINATION_TIMEOUT_MS = 10 * 60_000;
const SPIKE_TAG_KEY = 'anycloud:lambda-network-spike';

type InstanceStatus =
  | 'booting'
  | 'active'
  | 'unhealthy'
  | 'terminated'
  | 'terminating'
  | 'preempted';

interface LambdaTag {
  key: string;
  value: string;
}

interface LambdaInstance {
  id: string;
  name?: string | null;
  ip?: string | null;
  private_ip?: string | null;
  status: InstanceStatus;
  region?: { name?: string };
  instance_type?: { name?: string };
  tags?: LambdaTag[];
}

interface LambdaFirewallRule {
  protocol: 'tcp' | 'udp';
  port_range: [number, number];
  source_network: string;
  description: string;
}

interface LambdaFirewallRuleset {
  id: string;
  name: string;
  region: { name: string };
  rules: LambdaFirewallRule[];
  instance_ids?: string[];
}

interface LambdaInstanceTypeEntry {
  instance_type?: {
    price_cents_per_hour?: number;
  };
  regions_with_capacity_available?: Array<{ name: string }>;
}

interface LambdaApiErrorBody {
  code?: string;
  message?: string;
  suggestion?: string;
}

interface ApiOptions {
  safeToRetry?: boolean;
}

class LambdaApiError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

class LambdaApi {
  private nextGeneralRequestAt = 0;
  private nextLaunchRequestAt = 0;
  private signal: AbortSignal | undefined;

  constructor(
    private readonly apiKey: string,
    signal: AbortSignal,
  ) {
    this.signal = signal;
  }

  beginCleanup(): void {
    this.signal = undefined;
  }

  private async pace(isLaunch: boolean): Promise<void> {
    const readyAt = isLaunch
      ? this.nextLaunchRequestAt
      : this.nextGeneralRequestAt;
    const waitMs = Math.max(0, readyAt - Date.now());
    if (waitMs > 0) {
      await delay(
        waitMs,
        undefined,
        this.signal ? { signal: this.signal } : {},
      );
    }
    if (isLaunch) {
      this.nextLaunchRequestAt = Date.now() + LAUNCH_REQUEST_INTERVAL_MS;
    } else {
      this.nextGeneralRequestAt = Date.now() + GENERAL_REQUEST_INTERVAL_MS;
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: ApiOptions = {},
  ): Promise<T> {
    const isLaunch = path === '/instance-operations/launch';
    const maxAttempts = options.safeToRetry ? 5 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.pace(isLaunch);
      const signals = [AbortSignal.timeout(API_TIMEOUT_MS)];
      if (this.signal) signals.push(this.signal);

      try {
        const response = await fetch(`${API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any(signals),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          data?: T;
          error?: LambdaApiErrorBody;
        };
        if (response.ok && payload.error === undefined) {
          return payload.data as T;
        }

        const providerError = payload.error;
        const error = new LambdaApiError(
          response.status,
          providerError?.code,
          `Lambda API ${method} ${path}: HTTP ${response.status}${
            providerError?.code ? ` [${providerError.code}]` : ''
          } ${providerError?.message ?? 'request failed'}${
            providerError?.suggestion ? ` (${providerError.suggestion})` : ''
          }`,
        );
        const retryable = response.status === 429 || response.status >= 500;
        if (!options.safeToRetry || !retryable || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (error instanceof LambdaApiError) throw error;
        if (!options.safeToRetry || attempt === maxAttempts) throw error;
        lastError = error;
      }
      await delay(5_000, undefined, this.signal ? { signal: this.signal } : {});
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Lambda API ${method} ${path} failed`);
  }
}

interface TrackedResources {
  instanceIds: Set<string>;
  rulesetIds: Set<string>;
  sshKeyId?: string;
}

interface ProbeContext {
  api: LambdaApi;
  runId: string;
  namePrefix: string;
  keyName: string;
  keyPath: string;
  tempRoot: string;
  tracked: TrackedResources;
}

interface RemoteProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function assertCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function isIPv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const number = Number(part);
      return number >= 0 && number <= 255;
    })
  );
}

function report(event: string, details: Record<string, unknown> = {}): void {
  const suffix = Object.keys(details).length
    ? ` ${JSON.stringify(details)}`
    : '';
  console.log(`LAMBDA_NETWORK_SPIKE ${event}${suffix}`);
}

function hasRunTag(instance: LambdaInstance, runId: string): boolean {
  return (
    instance.tags?.some(
      (tag) => tag.key === SPIKE_TAG_KEY && tag.value === runId,
    ) ?? false
  );
}

function baseRules(sourceCidr: string): LambdaFirewallRule[] {
  return [
    {
      protocol: 'tcp',
      port_range: [SSH_PORT, SSH_PORT],
      source_network: sourceCidr,
      description: 'Spike SSH control',
    },
    {
      protocol: 'tcp',
      port_range: [RAW_TCP_PORT, RAW_TCP_PORT],
      source_network: sourceCidr,
      description: 'Spike public raw TCP',
    },
  ];
}

function scopedRules(
  sourceCidr: string,
  memberPrivateIps: string[],
): LambdaFirewallRule[] {
  return [
    ...baseRules(sourceCidr),
    ...memberPrivateIps.flatMap((privateIp) => [
      {
        protocol: 'tcp' as const,
        port_range: [KUBELET_PORT, KUBELET_PORT] as [number, number],
        source_network: `${privateIp}/32`,
        description: 'Spike same-scope kubelet traffic',
      },
      {
        protocol: 'udp' as const,
        port_range: [FLANNEL_PORT, FLANNEL_PORT] as [number, number],
        source_network: `${privateIp}/32`,
        description: 'Spike same-scope Flannel traffic',
      },
    ]),
  ];
}

function scopedTcpRules(
  sourceCidr: string,
  memberPrivateIps: string[],
): LambdaFirewallRule[] {
  return [
    ...baseRules(sourceCidr),
    ...memberPrivateIps.map((privateIp) => ({
      protocol: 'tcp' as const,
      port_range: [KUBELET_PORT, KUBELET_PORT] as [number, number],
      source_network: `${privateIp}/32`,
      description: 'Spike same-scope kubelet traffic',
    })),
  ];
}

function probeUserData(role: string): string {
  assertCondition(/^[a-z][a-z0-9-]{1,20}$/.test(role), 'Invalid probe role');
  const server = `#!/usr/bin/env python3
import socket
import threading

ROLE = ${JSON.stringify(role)}

def serve_tcp(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.listen(32)
    while True:
        conn, _ = sock.accept()
        with conn:
            conn.recv(128)
            conn.sendall(f"{ROLE}:tcp".encode())

def serve_udp(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))
    while True:
        data, address = sock.recvfrom(128)
        if data:
            sock.sendto(f"{ROLE}:udp".encode(), address)

for port in (${RAW_TCP_PORT}, ${KUBELET_PORT}):
    threading.Thread(target=serve_tcp, args=(port,), daemon=True).start()
serve_udp(${FLANNEL_PORT})
threading.Event().wait()
`;
  const unit = `[Unit]
Description=AnyCloud Lambda network feasibility probe
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/bin/anycloud-network-probe.py
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`;

  return `#cloud-config
write_files:
  - path: /usr/local/bin/anycloud-network-probe.py
    owner: root:root
    permissions: '0755'
    encoding: b64
    content: ${Buffer.from(server).toString('base64')}
  - path: /etc/systemd/system/anycloud-network-probe.service
    owner: root:root
    permissions: '0644'
    encoding: b64
    content: ${Buffer.from(unit).toString('base64')}
runcmd:
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, anycloud-network-probe.service]
`;
}

async function listInstances(api: LambdaApi): Promise<LambdaInstance[]> {
  return api.request<LambdaInstance[]>('GET', '/instances', undefined, {
    safeToRetry: true,
  });
}

async function listRulesets(api: LambdaApi): Promise<LambdaFirewallRuleset[]> {
  return api.request<LambdaFirewallRuleset[]>(
    'GET',
    '/firewall-rulesets',
    undefined,
    { safeToRetry: true },
  );
}

async function createRuleset(
  context: ProbeContext,
  name: string,
  region: string,
  rules: LambdaFirewallRule[],
): Promise<LambdaFirewallRuleset> {
  try {
    const ruleset = await context.api.request<LambdaFirewallRuleset>(
      'POST',
      '/firewall-rulesets',
      { name, region, rules },
    );
    context.tracked.rulesetIds.add(ruleset.id);
    return ruleset;
  } catch (error) {
    const adopted = (await listRulesets(context.api)).find(
      (candidate) =>
        candidate.name === name && candidate.region?.name === region,
    );
    if (!adopted) throw error;
    context.tracked.rulesetIds.add(adopted.id);
    return adopted;
  }
}

async function patchRuleset(
  api: LambdaApi,
  rulesetId: string,
  rules: LambdaFirewallRule[],
): Promise<void> {
  await api.request<LambdaFirewallRuleset>(
    'PATCH',
    `/firewall-rulesets/${rulesetId}`,
    { rules },
    { safeToRetry: true },
  );
}

async function probePrivateSourceRules(
  api: LambdaApi,
  rulesetId: string,
  sourceCidr: string,
  memberPrivateIps: string[],
): Promise<boolean> {
  try {
    // Isolate private CIDR acceptance from UDP support first.
    await patchRuleset(
      api,
      rulesetId,
      scopedTcpRules(sourceCidr, memberPrivateIps),
    );
    await patchRuleset(
      api,
      rulesetId,
      scopedRules(sourceCidr, memberPrivateIps),
    );
    report('private-source-rules-accepted', { accepted: true });
    return true;
  } catch (error) {
    if (!(error instanceof LambdaApiError) || error.status !== 400) throw error;
    report('private-source-rules-accepted', {
      accepted: false,
      status: error.status,
      providerCode: error.providerCode,
    });
    await patchRuleset(api, rulesetId, baseRules(sourceCidr));
    return false;
  }
}

async function launchInstance(
  context: ProbeContext,
  input: {
    name: string;
    role: string;
    region: string;
    vmType: string;
    rulesetId: string;
    scope: string;
  },
): Promise<string> {
  const body = {
    region_name: input.region,
    instance_type_name: input.vmType,
    ssh_key_names: [context.keyName],
    quantity: 1,
    name: input.name,
    image: { family: IMAGE_FAMILY },
    firewall_rulesets: [{ id: input.rulesetId }],
    user_data: probeUserData(input.role),
    tags: [
      { key: SPIKE_TAG_KEY, value: context.runId },
      { key: 'anycloud:resource-scope', value: input.scope },
      { key: 'anycloud:probe-role', value: input.role },
    ],
  };

  try {
    const launched = await context.api.request<{ instance_ids: string[] }>(
      'POST',
      '/instance-operations/launch',
      body,
    );
    const id = launched.instance_ids[0];
    assertCondition(id, `Lambda returned no instance ID for ${input.role}`);
    context.tracked.instanceIds.add(id);
    report('launched', { role: input.role, idSuffix: id.slice(-6) });
    return id;
  } catch (launchError) {
    // Lambda has no idempotency token. Never blindly repeat an uncertain
    // launch; settle-poll by the exact unique name and adopt it instead.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const adopted = (await listInstances(context.api)).find(
        (instance) =>
          instance.name === input.name &&
          instance.status !== 'terminated' &&
          instance.status !== 'terminating',
      );
      if (adopted) {
        context.tracked.instanceIds.add(adopted.id);
        report('adopted-uncertain-launch', {
          role: input.role,
          idSuffix: adopted.id.slice(-6),
        });
        return adopted.id;
      }
      await delay(5_000);
    }
    throw launchError;
  }
}

async function waitForActiveInstances(
  api: LambdaApi,
  ids: string[],
): Promise<Map<string, LambdaInstance>> {
  const deadline = Date.now() + ACTIVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const inventory = await listInstances(api);
    const byId = new Map(inventory.map((instance) => [instance.id, instance]));
    const observed = ids.map((id) => byId.get(id));
    for (const instance of observed) {
      if (
        instance &&
        ['unhealthy', 'terminated', 'terminating', 'preempted'].includes(
          instance.status,
        )
      ) {
        throw new Error(
          `Lambda instance ${instance.id.slice(-6)} entered ${instance.status}`,
        );
      }
    }
    if (
      observed.every(
        (instance) =>
          instance?.status === 'active' && instance.ip && instance.private_ip,
      )
    ) {
      return new Map(observed.map((instance) => [instance!.id, instance!]));
    }
    await delay(5_000);
  }
  throw new Error('Timed out waiting for Lambda instances to become active');
}

function sshArgs(keyPath: string, publicIp: string): string[] {
  return [
    '-i',
    keyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=2',
    `ubuntu@${publicIp}`,
  ];
}

function runSsh(
  keyPath: string,
  publicIp: string,
  remoteArgs: string[],
  input?: string,
): RemoteProbeResult {
  const result = spawnSync(
    'ssh',
    [...sshArgs(keyPath, publicIp), ...remoteArgs],
    {
      encoding: 'utf8',
      input,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return {
    exitCode: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

async function waitForProbeService(
  keyPath: string,
  instance: LambdaInstance,
): Promise<void> {
  assertCondition(instance.ip, 'Lambda instance has no public IP');
  const deadline = Date.now() + SSH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = runSsh(keyPath, instance.ip, [
      'sudo',
      '-n',
      'systemctl',
      'is-active',
      '--quiet',
      'anycloud-network-probe.service',
    ]);
    if (result.exitCode === 0) return;
    await delay(10_000);
  }
  throw new Error(
    `Timed out waiting for probe service on ${instance.id.slice(-6)}`,
  );
}

const REMOTE_TCP_PROBE = `import socket, sys
sock = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=4)
sock.sendall(b"probe")
response = sock.recv(128).decode()
print(response)
sys.exit(0 if response == sys.argv[3] else 3)
`;

const REMOTE_UDP_PROBE = `import socket, sys
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(4)
sock.sendto(b"probe", (sys.argv[1], int(sys.argv[2])))
response, _ = sock.recvfrom(128)
decoded = response.decode()
print(decoded)
sys.exit(0 if decoded == sys.argv[3] else 3)
`;

function remoteProbe(
  keyPath: string,
  source: LambdaInstance,
  target: LambdaInstance,
  protocol: 'tcp' | 'udp',
  targetRole: string,
): RemoteProbeResult {
  assertCondition(source.ip, 'Probe source has no public IP');
  assertCondition(target.private_ip, 'Probe target has no private IP');
  const port = protocol === 'tcp' ? KUBELET_PORT : FLANNEL_PORT;
  return runSsh(
    keyPath,
    source.ip,
    [
      'python3',
      '-',
      target.private_ip,
      String(port),
      `${targetRole}:${protocol}`,
    ],
    protocol === 'tcp' ? REMOTE_TCP_PROBE : REMOTE_UDP_PROBE,
  );
}

async function assertReachable(
  keyPath: string,
  source: LambdaInstance,
  sourceRole: string,
  target: LambdaInstance,
  targetRole: string,
  protocol: 'tcp' | 'udp',
): Promise<void> {
  const deadline = Date.now() + NETWORK_CONVERGENCE_TIMEOUT_MS;
  let lastResult: RemoteProbeResult | undefined;
  while (Date.now() < deadline) {
    lastResult = remoteProbe(keyPath, source, target, protocol, targetRole);
    if (lastResult.exitCode === 0) {
      report('reachable', {
        source: sourceRole,
        target: targetRole,
        protocol,
      });
      return;
    }
    await delay(5_000);
  }
  throw new Error(
    `${sourceRole} could not reach ${targetRole} over private ${protocol}: ${
      lastResult?.stderr || `exit ${String(lastResult?.exitCode)}`
    }`,
  );
}

async function observePrivateReachability(
  keyPath: string,
  source: LambdaInstance,
  sourceRole: string,
  target: LambdaInstance,
  targetRole: string,
  protocol: 'tcp' | 'udp',
): Promise<boolean> {
  let transportFailures = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = remoteProbe(keyPath, source, target, protocol, targetRole);
    if (result.exitCode === 0) {
      report('private-reachable', {
        source: sourceRole,
        target: targetRole,
        protocol,
      });
      return true;
    }
    if (result.exitCode === 255 || result.exitCode === null) {
      transportFailures++;
    }
    await delay(2_000);
  }
  assertCondition(
    transportFailures < 3,
    `Could not verify ${sourceRole} isolation because SSH transport failed`,
  );
  report('private-blocked', {
    source: sourceRole,
    target: targetRole,
    protocol,
  });
  return false;
}

async function probePublicRawTcp(
  instance: LambdaInstance,
  expectedRole: string,
): Promise<boolean> {
  assertCondition(instance.ip, 'Public raw-TCP target has no public IP');
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: instance.ip!, port: RAW_TCP_PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 10_000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write('probe'));
    socket.once('data', (data: string) => {
      clearTimeout(timeout);
      socket.destroy();
      if (data === `${expectedRole}:tcp`) resolve(true);
      else reject(new Error(`Unexpected public raw-TCP response: ${data}`));
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function assertPublicRawTcp(
  instance: LambdaInstance,
  expectedRole: string,
): Promise<void> {
  const deadline = Date.now() + NETWORK_CONVERGENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probePublicRawTcp(instance, expectedRole)) {
      report('public-raw-tcp-reachable', {
        role: expectedRole,
        port: RAW_TCP_PORT,
      });
      return;
    }
    await delay(3_000);
  }
  throw new Error('Public raw-TCP rule did not become reachable');
}

async function assertPublicRawTcpBlocked(
  instance: LambdaInstance,
  expectedRole: string,
): Promise<void> {
  const deadline = Date.now() + NETWORK_CONVERGENCE_TIMEOUT_MS;
  let consecutiveBlocks = 0;
  while (Date.now() < deadline) {
    if (await probePublicRawTcp(instance, expectedRole)) {
      consecutiveBlocks = 0;
    } else {
      consecutiveBlocks++;
      if (consecutiveBlocks === 2) {
        report('public-raw-tcp-blocked', {
          role: expectedRole,
          port: RAW_TCP_PORT,
        });
        return;
      }
    }
    await delay(3_000);
  }
  throw new Error('Public raw-TCP rule removal did not block the port');
}

function sshOnlyRules(sourceCidr: string): LambdaFirewallRule[] {
  return baseRules(sourceCidr).filter(
    (rule) => rule.port_range[0] !== RAW_TCP_PORT,
  );
}

async function terminateInstances(
  api: LambdaApi,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await api.request<unknown>(
    'POST',
    '/instance-operations/terminate',
    { instance_ids: ids },
    { safeToRetry: true },
  );
}

async function waitForTerminated(api: LambdaApi, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const inventory = await listInstances(api);
    const remaining = inventory.filter(
      (instance) =>
        ids.includes(instance.id) && instance.status !== 'terminated',
    );
    if (remaining.length === 0) return;
    await delay(5_000);
  }
  throw new Error(
    `Timed out waiting for Lambda instances to terminate: ${ids
      .map((id) => id.slice(-6))
      .join(', ')}`,
  );
}

async function terminateAndConfirm(api: LambdaApi, id: string): Promise<void> {
  const inventory = await listInstances(api);
  const instance = inventory.find((candidate) => candidate.id === id);
  if (instance && !['terminated', 'terminating'].includes(instance.status)) {
    await terminateInstances(api, [id]);
  }
  await waitForTerminated(api, [id]);
  report('terminated', { idSuffix: id.slice(-6) });
}

async function discoverSourceCidr(): Promise<string> {
  const configured = process.env.ANYCLOUD_LAMBDA_NETWORK_SPIKE_SOURCE_CIDR;
  if (configured) {
    const [address, prefix] = configured.split('/');
    assertCondition(
      address && isIPv4(address) && prefix === '32',
      'ANYCLOUD_LAMBDA_NETWORK_SPIKE_SOURCE_CIDR must be an IPv4 /32',
    );
    return configured;
  }
  const response = await fetch('https://api.ipify.org', {
    signal: AbortSignal.timeout(15_000),
  });
  assertCondition(response.ok, 'Could not discover the caller public IPv4');
  const address = (await response.text()).trim();
  assertCondition(isIPv4(address), 'Caller public address is not IPv4');
  return `${address}/32`;
}

async function selectTarget(api: LambdaApi): Promise<{
  vmType: string;
  region: string;
  priceCentsPerHour?: number;
}> {
  const vmType =
    process.env.ANYCLOUD_LAMBDA_NETWORK_SPIKE_VM_TYPE ?? DEFAULT_VM_TYPE;
  assertCondition(
    /^[a-z0-9][a-z0-9_]{1,62}$/.test(vmType),
    'Invalid Lambda spike VM type',
  );
  const types = await api.request<Record<string, LambdaInstanceTypeEntry>>(
    'GET',
    '/instance-types',
    undefined,
    { safeToRetry: true },
  );
  const entry = types[vmType];
  assertCondition(entry, `Lambda VM type ${vmType} is unavailable`);
  const capacityRegions = (entry.regions_with_capacity_available ?? [])
    .map((region) => region.name)
    .sort();
  const configuredRegion = process.env.ANYCLOUD_LAMBDA_NETWORK_SPIKE_REGION;
  if (configuredRegion) {
    assertCondition(
      capacityRegions.includes(configuredRegion),
      `${vmType} has no current capacity in ${configuredRegion}`,
    );
  }
  const region = configuredRegion ?? capacityRegions[0];
  assertCondition(region, `${vmType} has no current Lambda capacity`);
  return {
    vmType,
    region,
    ...(entry.instance_type?.price_cents_per_hour === undefined
      ? {}
      : { priceCentsPerHour: entry.instance_type.price_cents_per_hour }),
  };
}

async function createSshKey(context: ProbeContext): Promise<void> {
  const created = await context.api.request<{
    id: string;
    private_key: string;
  }>('POST', '/ssh-keys', { name: context.keyName });
  assertCondition(
    created.id && created.private_key,
    'Lambda returned no SSH key',
  );
  context.tracked.sshKeyId = created.id;
  writeFileSync(context.keyPath, created.private_key, { mode: 0o400 });
  chmodSync(context.keyPath, 0o400);
}

async function runProbe(context: ProbeContext): Promise<void> {
  const sourceCidr = await discoverSourceCidr();
  const target = await selectTarget(context.api);
  report('target', {
    region: target.region,
    vmType: target.vmType,
    priceCentsPerHour: target.priceCentsPerHour,
    maxConcurrentVms: 2,
  });

  await createSshKey(context);
  const scopeA = `${context.runId}-a`;
  const scopeB = `${context.runId}-b`;
  const rulesetA = await createRuleset(
    context,
    `${context.namePrefix}-a`,
    target.region,
    baseRules(sourceCidr),
  );

  const a1Id = await launchInstance(context, {
    name: `${context.namePrefix}-a1`,
    role: 'scope-a-one',
    region: target.region,
    vmType: target.vmType,
    rulesetId: rulesetA.id,
    scope: scopeA,
  });
  const a2Id = await launchInstance(context, {
    name: `${context.namePrefix}-a2`,
    role: 'scope-a-two',
    region: target.region,
    vmType: target.vmType,
    rulesetId: rulesetA.id,
    scope: scopeA,
  });
  let active = await waitForActiveInstances(context.api, [a1Id, a2Id]);
  const a1 = active.get(a1Id)!;
  const a2 = active.get(a2Id)!;
  await waitForProbeService(context.keyPath, a1);
  await waitForProbeService(context.keyPath, a2);
  await assertPublicRawTcp(a1, 'scope-a-one');

  // Public firewall rulesets are mutable on already-running instances.
  await patchRuleset(context.api, rulesetA.id, sshOnlyRules(sourceCidr));
  await assertPublicRawTcpBlocked(a1, 'scope-a-one');
  await patchRuleset(context.api, rulesetA.id, baseRules(sourceCidr));
  await assertPublicRawTcp(a1, 'scope-a-one');
  report('public-ruleset-mutation-proven', {
    rulesetIdSuffix: rulesetA.id.slice(-6),
  });

  // Observe private behavior before the peer ports are present in the ruleset.
  const unconfiguredPrivateTcpReachable = await observePrivateReachability(
    context.keyPath,
    a1,
    'scope-a-one',
    a2,
    'scope-a-two',
    'tcp',
  );
  const unconfiguredPrivateUdpReachable = await observePrivateReachability(
    context.keyPath,
    a1,
    'scope-a-one',
    a2,
    'scope-a-two',
    'udp',
  );
  const privateTrafficFilteredByRuleset = !(
    unconfiguredPrivateTcpReachable || unconfiguredPrivateUdpReachable
  );
  report('private-filter-observation', {
    rulesetOmittedPeerPorts: true,
    tcpReachable: unconfiguredPrivateTcpReachable,
    udpReachable: unconfiguredPrivateUdpReachable,
  });

  assertCondition(a1.private_ip && a2.private_ip, 'Missing private IP');
  const privateSourceRulesAccepted = await probePrivateSourceRules(
    context.api,
    rulesetA.id,
    sourceCidr,
    [a1.private_ip, a2.private_ip],
  );
  await assertReachable(
    context.keyPath,
    a1,
    'scope-a-one',
    a2,
    'scope-a-two',
    'tcp',
  );
  await assertReachable(
    context.keyPath,
    a2,
    'scope-a-two',
    a1,
    'scope-a-one',
    'udp',
  );
  report('same-scope-private-peer-traffic-proven');

  await terminateAndConfirm(context.api, a2Id);
  if (privateSourceRulesAccepted) {
    await patchRuleset(
      context.api,
      rulesetA.id,
      scopedRules(sourceCidr, [a1.private_ip]),
    );
  }

  const rulesetB = await createRuleset(
    context,
    `${context.namePrefix}-b`,
    target.region,
    baseRules(sourceCidr),
  );
  const b1Id = await launchInstance(context, {
    name: `${context.namePrefix}-b1`,
    role: 'scope-b-one',
    region: target.region,
    vmType: target.vmType,
    rulesetId: rulesetB.id,
    scope: scopeB,
  });
  active = await waitForActiveInstances(context.api, [a1Id, b1Id]);
  const b1 = active.get(b1Id)!;
  await waitForProbeService(context.keyPath, b1);
  const crossScopeAToBTcp = await observePrivateReachability(
    context.keyPath,
    a1,
    'scope-a-one',
    b1,
    'scope-b-one',
    'tcp',
  );
  const crossScopeBToATcp = await observePrivateReachability(
    context.keyPath,
    b1,
    'scope-b-one',
    a1,
    'scope-a-one',
    'tcp',
  );
  const crossScopeAToBUdp = await observePrivateReachability(
    context.keyPath,
    a1,
    'scope-a-one',
    b1,
    'scope-b-one',
    'udp',
  );
  const crossScopeBToAUdp = await observePrivateReachability(
    context.keyPath,
    b1,
    'scope-b-one',
    a1,
    'scope-a-one',
    'udp',
  );
  const independentScopeIsolation = !(
    crossScopeAToBTcp ||
    crossScopeBToATcp ||
    crossScopeAToBUdp ||
    crossScopeBToAUdp
  );
  report('cross-scope-observation', {
    independentScopeIsolation,
    aToBTcpReachable: crossScopeAToBTcp,
    bToATcpReachable: crossScopeBToATcp,
    aToBUdpReachable: crossScopeAToBUdp,
    bToAUdpReachable: crossScopeBToAUdp,
  });
  await terminateAndConfirm(context.api, b1Id);

  if (
    !privateSourceRulesAccepted ||
    !privateTrafficFilteredByRuleset ||
    !independentScopeIsolation
  ) {
    report('verdict', {
      supported: false,
      sameScopePrivatePeerTraffic: true,
      privateSourceRulesAccepted,
      privateTrafficFilteredByRuleset,
      independentScopeIsolation,
      publicRulesetsMutable: true,
      replacementAdoption: 'not-run-after-network-rejection',
    });
    return;
  }

  // Simulate a fresh reconciler discovering the durable ruleset by name.
  const adoptedRuleset = (await listRulesets(context.api)).find(
    (candidate) =>
      candidate.name === `${context.namePrefix}-a` &&
      candidate.region?.name === target.region,
  );
  assertCondition(adoptedRuleset, 'Could not adopt scope A ruleset by name');
  assertCondition(
    adoptedRuleset.id === rulesetA.id,
    'Ruleset adoption selected a different provider resource',
  );

  const a3Id = await launchInstance(context, {
    name: `${context.namePrefix}-a3`,
    role: 'scope-a-three',
    region: target.region,
    vmType: target.vmType,
    rulesetId: adoptedRuleset.id,
    scope: scopeA,
  });
  active = await waitForActiveInstances(context.api, [a1Id, a3Id]);
  const a3 = active.get(a3Id)!;
  await waitForProbeService(context.keyPath, a3);

  // Record whether Lambda applies private source membership before updating it.
  await assertReachable(
    context.keyPath,
    a1,
    'scope-a-one',
    a3,
    'scope-a-three',
    'tcp',
  );
  const replacementReachedBeforeMembership = await observePrivateReachability(
    context.keyPath,
    a3,
    'scope-a-three',
    a1,
    'scope-a-one',
    'tcp',
  );
  assertCondition(a3.private_ip, 'Replacement VM has no private IP');
  if (privateSourceRulesAccepted) {
    await patchRuleset(
      context.api,
      adoptedRuleset.id,
      scopedRules(sourceCidr, [a1.private_ip, a3.private_ip]),
    );
  }
  await assertReachable(
    context.keyPath,
    a3,
    'scope-a-three',
    a1,
    'scope-a-one',
    'tcp',
  );
  await assertReachable(
    context.keyPath,
    a1,
    'scope-a-one',
    a3,
    'scope-a-three',
    'udp',
  );
  await assertReachable(
    context.keyPath,
    a3,
    'scope-a-three',
    a1,
    'scope-a-one',
    'udp',
  );

  const adoptedInstances = (await listInstances(context.api)).filter(
    (instance) =>
      hasRunTag(instance, context.runId) && instance.status === 'active',
  );
  assertCondition(
    adoptedInstances.length === 2 &&
      adoptedInstances.some((instance) => instance.id === a1Id) &&
      adoptedInstances.some((instance) => instance.id === a3Id),
    'Tag-based VM adoption did not recover the expected live scope members',
  );
  report('replacement-and-adoption-proven', {
    liveScopeMembers: adoptedInstances.length,
    reachedBeforeMembership: replacementReachedBeforeMembership,
  });
  report('verdict', {
    supported: true,
    sameScopePrivatePeerTraffic: true,
    privateSourceRulesAccepted,
    privateTrafficFilteredByRuleset,
    independentScopeIsolation,
    publicRulesetsMutable: true,
    replacementAdoption: true,
  });
}

async function cleanup(context: ProbeContext): Promise<string[]> {
  context.api.beginCleanup();
  const errors: string[] = [];
  report('cleanup-start');

  try {
    const inventory = await listInstances(context.api);
    const owned = inventory.filter(
      (instance) =>
        hasRunTag(instance, context.runId) ||
        instance.name?.startsWith(context.namePrefix),
    );
    for (const instance of owned) context.tracked.instanceIds.add(instance.id);
    const toTerminate = owned
      .filter(
        (instance) =>
          instance.status !== 'terminated' && instance.status !== 'terminating',
      )
      .map((instance) => instance.id);
    await terminateInstances(context.api, toTerminate);
    await waitForTerminated(context.api, [...context.tracked.instanceIds]);
  } catch (error) {
    errors.push(
      `instance cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (errors.length === 0) {
    for (const rulesetId of context.tracked.rulesetIds) {
      let deleted = false;
      for (let attempt = 0; attempt < 10 && !deleted; attempt++) {
        try {
          await context.api.request<unknown>(
            'DELETE',
            `/firewall-rulesets/${rulesetId}`,
            undefined,
            { safeToRetry: true },
          );
          deleted = true;
        } catch (error) {
          if (
            error instanceof LambdaApiError &&
            (error.status === 404 ||
              error.providerCode === 'global/object-does-not-exist')
          ) {
            deleted = true;
          } else if (attempt === 9) {
            errors.push(
              `ruleset ${rulesetId.slice(-6)} cleanup: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } else {
            await delay(5_000);
          }
        }
      }
    }

    if (context.tracked.sshKeyId) {
      try {
        await context.api.request<unknown>(
          'DELETE',
          `/ssh-keys/${context.tracked.sshKeyId}`,
          undefined,
          { safeToRetry: true },
        );
      } catch (error) {
        if (
          !(
            error instanceof LambdaApiError &&
            (error.status === 404 ||
              error.providerCode === 'global/object-does-not-exist')
          )
        ) {
          errors.push(
            `SSH key cleanup: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  if (errors.length === 0) {
    rmSync(context.tempRoot, { recursive: true, force: true });
    report('cleanup-complete', {
      instances: context.tracked.instanceIds.size,
      rulesets: context.tracked.rulesetIds.size,
      sshKey: context.tracked.sshKeyId ? 1 : 0,
    });
  } else {
    report('cleanup-incomplete', {
      errors,
      runId: context.runId,
      retainedKeyDirectory: context.tempRoot,
    });
  }
  return errors;
}

async function main(): Promise<void> {
  const apiKey = process.env.LAMBDA_API_KEY;
  assertCondition(apiKey, 'LAMBDA_API_KEY is required');

  const abortController = new AbortController();
  let interruptedSignal: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedSignal = signal;
    abortController.abort(new Error(`Interrupted by ${signal}`));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  const runId = randomBytes(5).toString('hex');
  const tempRoot = mkdtempSync(join(tmpdir(), `anycloud-lambda-net-${runId}-`));
  const context: ProbeContext = {
    api: new LambdaApi(apiKey, abortController.signal),
    runId,
    namePrefix: `ac-k8s-net-${runId}`,
    keyName: `ac-k8s-net-${runId}-key`,
    keyPath: join(tempRoot, 'id_ed25519'),
    tempRoot,
    tracked: {
      instanceIds: new Set<string>(),
      rulesetIds: new Set<string>(),
    },
  };

  let probeError: unknown;
  try {
    report('start', { runId });
    await runProbe(context);
  } catch (error) {
    probeError = error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }

  const cleanupErrors = await cleanup(context);
  if (interruptedSignal) {
    throw new Error(`Lambda network spike interrupted by ${interruptedSignal}`);
  }
  if (probeError) throw probeError;
  if (cleanupErrors.length > 0) {
    throw new Error(
      `Lambda network spike cleanup failed: ${cleanupErrors.join('; ')}`,
    );
  }
}

void main().catch((error) => {
  console.error(
    `LAMBDA_NETWORK_SPIKE failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
