import { request as httpRequest } from 'node:http';

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

interface DockerErrorBody {
  message?: string;
}

export interface DockerContainerInspection {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Labels: Record<string, string> | null;
  };
  State: {
    Running: boolean;
    Status: string;
    ExitCode: number;
  };
}

export interface DockerNetworkInspection {
  Id: string;
  Name: string;
  Labels: Record<string, string> | null;
}

interface DockerResponse {
  status: number;
  body: Buffer;
}

function dockerError(operation: string, response: DockerResponse): Error {
  let message = response.body.toString('utf8').trim();
  try {
    const parsed = JSON.parse(message) as DockerErrorBody;
    message = parsed.message?.trim() || message;
  } catch {
    // Docker sometimes returns text rather than JSON.
  }
  return new Error(
    `Docker Engine ${operation} failed (${response.status})${message ? `: ${message}` : ''}`,
  );
}

function decodeDockerStream(body: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= body.length) {
    const stream = body[offset];
    const length = body.readUInt32BE(offset + 4);
    if (![0, 1, 2].includes(stream) || offset + 8 + length > body.length) {
      return body.toString('utf8');
    }
    chunks.push(body.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return offset === body.length
    ? Buffer.concat(chunks).toString('utf8')
    : body.toString('utf8');
}

/** Minimal Docker Engine UDS client for the local-cluster harness's K3s containers. */
export class DockerEngine {
  constructor(private readonly socketPath = DEFAULT_DOCKER_SOCKET) {
    if (!socketPath.startsWith('/') || socketPath.includes('\0')) {
      throw new Error('Docker Engine socket path must be absolute');
    }
  }

  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const encoded =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: encoded
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(encoded.byteLength),
              }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              request.destroy(new Error('Docker Engine response is too large'));
              return;
            }
            chunks.push(buffer);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 500,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Docker Engine ${method} ${path} timed out`));
      });
      request.once('error', reject);
      request.end(encoded);
    });
  }

  private async json<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const response = await this.request(method, path, body, timeoutMs);
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(operation, response);
    }
    return (
      response.body.length === 0
        ? {}
        : JSON.parse(response.body.toString('utf8'))
    ) as T;
  }

  async ping(): Promise<void> {
    const response = await this.request('GET', '/_ping');
    if (
      response.status !== 200 ||
      response.body.toString('utf8').trim() !== 'OK'
    ) {
      throw dockerError('ping', response);
    }
  }

  async pullImage(image: string): Promise<void> {
    const response = await this.request(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      undefined,
      15 * 60_000,
    );
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(`pull image ${image}`, response);
    }
    const lines = response.body.toString('utf8').trim().split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { error?: string };
        if (event.error)
          throw new Error(`Docker image pull failed: ${event.error}`);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  async hasImage(image: string): Promise<boolean> {
    const response = await this.request(
      'GET',
      `/images/${encodeURIComponent(image)}/json`,
    );
    if (response.status === 404) return false;
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(`inspect image ${image}`, response);
    }
    return true;
  }

  async inspectContainer(
    name: string,
  ): Promise<DockerContainerInspection | null> {
    const response = await this.request(
      'GET',
      `/containers/${encodeURIComponent(name)}/json`,
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(`inspect container ${name}`, response);
    }
    return JSON.parse(
      response.body.toString('utf8'),
    ) as DockerContainerInspection;
  }

  async createContainer(name: string, config: unknown): Promise<string> {
    const result = await this.json<{ Id?: string }>(
      `create container ${name}`,
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      config,
    );
    if (!result.Id)
      throw new Error(`Docker Engine omitted ID for container ${name}`);
    return result.Id;
  }

  async startContainer(name: string): Promise<void> {
    const response = await this.request(
      'POST',
      `/containers/${encodeURIComponent(name)}/start`,
    );
    if (response.status !== 204 && response.status !== 304) {
      throw dockerError(`start container ${name}`, response);
    }
  }

  async stopContainer(name: string, timeoutSeconds = 30): Promise<void> {
    const response = await this.request(
      'POST',
      `/containers/${encodeURIComponent(name)}/stop?t=${timeoutSeconds}`,
      undefined,
      (timeoutSeconds + 15) * 1000,
    );
    if (![204, 304, 404].includes(response.status)) {
      throw dockerError(`stop container ${name}`, response);
    }
  }

  async removeContainer(name: string, force = false): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/containers/${encodeURIComponent(name)}?force=${force ? 'true' : 'false'}&v=true`,
    );
    if (response.status !== 204 && response.status !== 404) {
      throw dockerError(`remove container ${name}`, response);
    }
  }

  async waitContainer(name: string, timeoutMs = 10 * 60_000): Promise<number> {
    const result = await this.json<{
      StatusCode?: number;
      Error?: { Message?: string };
    }>(
      `wait for container ${name}`,
      'POST',
      `/containers/${encodeURIComponent(name)}/wait?condition=not-running`,
      undefined,
      timeoutMs,
    );
    if (result.Error?.Message) throw new Error(result.Error.Message);
    if (!Number.isInteger(result.StatusCode)) {
      throw new Error(`Docker Engine omitted exit code for container ${name}`);
    }
    return result.StatusCode!;
  }

  async containerLogs(name: string, tailLines = 200): Promise<string> {
    const response = await this.request(
      'GET',
      `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=true&tail=${String(tailLines)}`,
    );
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(`read logs for container ${name}`, response);
    }
    return decodeDockerStream(response.body);
  }

  async exec(
    container: string,
    command: string[],
    timeoutMs = 10 * 60_000,
  ): Promise<string> {
    const created = await this.json<{ Id?: string }>(
      `create exec in ${container}`,
      'POST',
      `/containers/${encodeURIComponent(container)}/exec`,
      {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: command,
      },
    );
    if (!created.Id)
      throw new Error(`Docker Engine omitted exec ID for ${container}`);
    const response = await this.request(
      'POST',
      `/exec/${encodeURIComponent(created.Id)}/start`,
      { Detach: false, Tty: false },
      timeoutMs,
    );
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(`start exec in ${container}`, response);
    }
    const inspected = await this.json<{ ExitCode?: number }>(
      `inspect exec in ${container}`,
      'GET',
      `/exec/${encodeURIComponent(created.Id)}/json`,
    );
    const output = decodeDockerStream(response.body);
    if (inspected.ExitCode !== 0) {
      throw new Error(
        `Command in container ${container} exited ${String(inspected.ExitCode)}${output.trim() ? `: ${output.trim()}` : ''}`,
      );
    }
    return output;
  }

  async inspectNetwork(name: string): Promise<DockerNetworkInspection | null> {
    const response = await this.request(
      'GET',
      `/networks/${encodeURIComponent(name)}`,
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw dockerError(`inspect network ${name}`, response);
    }
    return JSON.parse(
      response.body.toString('utf8'),
    ) as DockerNetworkInspection;
  }

  async createNetwork(
    name: string,
    labels: Record<string, string>,
  ): Promise<void> {
    await this.json(`create network ${name}`, 'POST', '/networks/create', {
      Name: name,
      CheckDuplicate: true,
      Driver: 'bridge',
      Labels: labels,
    });
  }

  async removeNetwork(name: string): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(name)}`,
    );
    if (response.status !== 204 && response.status !== 404) {
      throw dockerError(`remove network ${name}`, response);
    }
  }
}
