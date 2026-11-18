export const SSH_PROCESS_CHUNK_BYTES = 64 * 1024;
export type SshOutput = 'stdout' | 'stderr';

export interface SshProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: { message: string; code?: string };
}

export interface SshProcessHost {
  output(id: number, stream: SshOutput, chunk: Buffer): Promise<void>;
  input(id: number): Buffer | null;
  started(id: number, pid: number): void;
}

export interface SshProcessWorker {
  ready(): void;
  run(
    id: number,
    args: string[],
    stdin: 'pipe' | 'ignore',
    input: boolean,
    binary: 'ssh' | 'ssh-keygen',
  ): Promise<SshProcessResult>;
  cancel(id: number): void;
  shutdown(): void;
}
