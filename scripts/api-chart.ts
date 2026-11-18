import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  SYSTEM_RELEASE_CHART_NAME,
  SYSTEM_RELEASE_HELM_JOB_IMAGE,
} from '../src/shared/system-release.js';

/**
 * Packages and publishes the API chart (`charts/anycloud-api`) as an OCI
 * artifact with the Helm that clusters run (helm-controller's pinned Job
 * image), and prints the digest-pinned reference an API image is built with
 * (Dockerfile `API_CHART`):
 *
 *   yarn -s chart:publish <version>
 *
 * Pushing uses the Docker login (`DOCKER_CONFIG` or `~/.docker`). Inputs reach
 * the container as a tar on stdin, so a remote Docker daemon works too. Helm
 * appends the chart name to the repository: `ghcr.io/anycloud-sh/api-k8-chart`.
 */
export const API_CHART_REPOSITORY = 'oci://ghcr.io/anycloud-sh';

const run = promisify(execFile);

/** Packages the chart at `version` in the Helm image, then runs `then` on `$CHART`. */
export async function inHelm(input: {
  version: string;
  chartDirectory?: string;
  then: string;
}): Promise<{ stdout: string; stderr: string }> {
  if (!/^[0-9A-Za-z.+-]+$/u.test(input.version)) {
    throw new Error(`invalid chart version ${input.version}`);
  }
  const staging = await mkdtemp(path.join(tmpdir(), 'anycloud-chart-'));
  try {
    await cp(
      input.chartDirectory ??
        fileURLToPath(new URL('../charts/anycloud-api', import.meta.url)),
      path.join(staging, 'chart'),
      { recursive: true },
    );
    // Helm falls back to the Docker login for registry credentials.
    const login = path.join(
      process.env.DOCKER_CONFIG ?? path.join(homedir(), '.docker'),
      'config.json',
    );
    await mkdir(path.join(staging, 'docker'));
    if (existsSync(login)) {
      await copyFile(login, path.join(staging, 'docker', 'config.json'));
    }
    // The image runs as a non-root user, so the work lives under /tmp/w; HOME
    // moves there too, defensively, so Helm's config and cache are disposable.
    const script = [
      'set -eu',
      'mkdir /tmp/w',
      'tar -x -C /tmp/w',
      'export HOME=/tmp/w',
      `helm package /tmp/w/chart --version ${input.version} --app-version ${input.version} --destination /tmp/w/out >&2`,
      `CHART=/tmp/w/out/${SYSTEM_RELEASE_CHART_NAME}-${input.version}.tgz`,
      input.then,
    ].join('\n');
    return await run(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        'tar -C "$0" -cf - . | docker run --rm --interactive --env DOCKER_CONFIG=/tmp/w/docker --entrypoint sh "$@"',
        staging,
        SYSTEM_RELEASE_HELM_JOB_IMAGE,
        '-c',
        script,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Packages and pushes the chart; returns `<repository>/api-k8-chart@sha256:…`. */
export async function publishApiChart(input: {
  version: string;
  repository?: string;
  plainHttp?: boolean;
}): Promise<string> {
  const repository = input.repository ?? API_CHART_REPOSITORY;
  if (!/^oci:\/\/[0-9A-Za-z.:/_-]+$/u.test(repository)) {
    throw new Error(`invalid chart repository ${repository}`);
  }
  const { stdout, stderr } = await inHelm({
    ...input,
    then: `helm push "$CHART" ${repository}${input.plainHttp ? ' --plain-http' : ''}`,
  });
  // Helm prints `Pushed: <ref>` then `Digest:`; Docker's own image pull
  // prints a `Digest:` line too, for the Helm image.
  const digest = /^Pushed: .*\nDigest: (sha256:[a-f0-9]{64})$/mu.exec(
    `${stdout}${stderr}`,
  )?.[1];
  if (!digest) throw new Error(`helm push printed no digest: ${stderr}`);
  return `${repository}/${SYSTEM_RELEASE_CHART_NAME}@${digest}`;
}

/**
 * helm-controller pulls the chart anonymously, as clusters pull the API
 * image: a new GHCR package is private until made public, which would fail
 * every install and upgrade. Refuse to hand out a reference nobody can pull.
 */
async function assertPublic(reference: string): Promise<void> {
  const [repository, digest] = reference
    .slice('oci://ghcr.io/'.length)
    .split('@');
  const token = (await fetch(
    `https://ghcr.io/token?scope=repository:${repository}:pull`,
  ).then((response) => response.json())) as { token?: string };
  const manifest = await fetch(
    `https://ghcr.io/v2/${repository}/manifests/${digest}`,
    {
      method: 'HEAD',
      headers: {
        Accept: 'application/vnd.oci.image.manifest.v1+json',
        ...(token.token ? { Authorization: `Bearer ${token.token}` } : {}),
      },
    },
  );
  if (!manifest.ok) {
    throw new Error(
      `${reference} cannot be pulled anonymously (HTTP ${manifest.status}); make the ghcr.io/${repository} package public`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version] = process.argv.slice(2);
  if (!version) throw new Error('usage: yarn -s chart:publish <version>');
  const reference = await publishApiChart({ version });
  await assertPublic(reference);
  process.stdout.write(`${reference}\n`);
}
