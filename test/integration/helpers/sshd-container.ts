/**
 * Containers running the SSH servers we actually talk to, for tests whose
 * subject is what a real server does. A protocol mock implements whatever its
 * test harness implements, so it cannot answer questions like "what happens
 * when a client disappears" or "what process group contains a session command"
 * — only a real server can.
 */

import { execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { SSHManager } from '../../../src/api/services/gateways/ssh';
import { MAX_WAIT_MS, Waiter } from '../e2e/internal/wait.js';

export interface SshdContainer {
  containerId: string;
  privateKey: string;
  port: number;
  /** Remove the container. Safe to call when startup already failed. */
  stop: () => void;
}

/** Workload image: no apt, and the pgrep/pkill (procps) bookworm-slim lacks. */
export const UBUNTU_BASE_IMAGE =
  'mirror.gcr.io/library/ubuntu:22.04@sha256:2edbbc5dc405e9612ba3584ce95480277e3eb374407b5505fe26f17df77c7dbc';

/**
 * Debian, not Ubuntu: apt reaches deb.debian.org through Fastly's CDN, while
 * archive.ubuntu.com is a handful of Canonical origin servers whose stalls
 * have pushed this build past every setup hook's timeout.
 */
const DEBIAN_BASE_IMAGE =
  'mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';

/** The runner image's pin; its static CLI speaks the host daemon's API. */
const DOCKER_CLI_IMAGE =
  'mirror.gcr.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c';

function opensshDockerfile(withDocker: boolean): string {
  return [
    `FROM ${DEBIAN_BASE_IMAGE}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends openssh-server',
    ...(withDocker
      ? [
          `COPY --from=${DOCKER_CLI_IMAGE} /usr/local/bin/docker /usr/local/bin/docker`,
        ]
      : []),
    'RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh',
    'RUN mkdir -p /run/sshd',
    'COPY authorized_keys /root/.ssh/authorized_keys',
    'RUN chmod 600 /root/.ssh/authorized_keys',
    'CMD ["/usr/sbin/sshd", "-D"]',
  ].join('\n');
}

/**
 * Build and start an OpenSSH server container, returning once it accepts our
 * key. OpenSSH is what every substrate AnyCloud reaches over SSH runs.
 *
 * Building the image (apt install) is network-bound, so callers should give
 * their setup hook generous headroom.
 */
export async function startSshdContainer(options: {
  /** Image tag, so concurrent suites do not clobber each other's builds. */
  tag: string;
  /** Host port to publish the server on. */
  port: number;
  /**
   * Give the container a docker CLI wired to the host daemon, so it can model a
   * VM that runs its workload in a container. Sibling containers, so no
   * privileged docker-in-docker.
   */
  withDocker?: boolean;
}): Promise<SshdContainer> {
  const { privateKey, publicKey } = await SSHManager.generateKeypair();

  const buildDir = `/tmp/${options.tag}`;
  execSync(`mkdir -p ${buildDir}`);
  execSync(`echo '${publicKey}' > ${buildDir}/authorized_keys`);

  console.log(`Building ${options.tag} image...`);
  execSync(
    `echo '${opensshDockerfile(options.withDocker ?? false)}' > ${buildDir}/Dockerfile`,
  );
  // Async, so the hook's timeout fires during a slow build, beside its log,
  // rather than after the build returns.
  const build = spawn('docker', ['build', '-t', options.tag, buildDir], {
    stdio: 'inherit',
  });
  const [code, signal] = (await once(build, 'exit')) as [
    number | null,
    NodeJS.Signals | null,
  ];
  if (code !== 0)
    throw new Error(
      `docker build ${options.tag} exited with ${code ?? signal}`,
    );
  const socket = options.withDocker
    ? '-v /var/run/docker.sock:/var/run/docker.sock '
    : '';
  const runCommand = `docker run -d ${socket}-p ${options.port}:22 ${options.tag}`;

  console.log('Starting SSH server container...');
  const containerId = execSync(runCommand).toString().trim();
  console.log(`Container started: ${containerId.slice(0, 12)}`);

  const stop = () => {
    execSync(`docker rm -f ${containerId}`, { stdio: 'inherit' });
  };

  console.log('Waiting for SSH server...');
  const probe = new SSHManager('127.0.0.1', privateKey, options.port);
  try {
    await new Waiter(new AbortController().signal).for(
      'SSH server',
      () => probe.ping(),
      {
        timeoutMs: MAX_WAIT_MS,
        intervalMs: Array<number>(29).fill(1_000),
        probeError: { retry: () => true },
        unmet: (ready) => (ready ? undefined : 'not ready'),
      },
    );
  } catch (error) {
    console.error(
      'Container logs:',
      execSync(`docker logs ${containerId}`).toString(),
    );
    stop();
    throw new Error('SSH server did not become ready', { cause: error });
  }
  console.log('SSH server ready!');
  // The probe shares host, port, username, key, and purpose with every
  // consumer's client, so it shares their ControlMaster. Awaiting the
  // close is what keeps the first test from adopting a master that is
  // already exiting — a keyless command client cannot survive that and
  // fails as if the key were wrong.
  await SSHManager.closeConnection('127.0.0.1', options.port);
  return { containerId, privateKey, port: options.port, stop };
}
