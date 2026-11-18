/** The existing process harness returns untrusted IPC records to its callers. */
export interface ReadModelChildOptions {
  readonly action: 'seed' | 'measure' | 'audit' | 'resume';
  readonly buildDir: string;
  readonly runDir: string;
  readonly profile?: 'smoke';
  readonly fixture?: Readonly<Record<string, unknown>>;
  readonly response?: 'settled';
  readonly boundary?: 'yield' | 'immediate';
  readonly copyFrom?: string;
  readonly cipherKey?: string;
  readonly delayMs?: number;
  readonly synchronousSettlementDelayMs?: number;
  readonly faultAfterWrites?: number;
  readonly faultEvidencePath?: string;
  readonly expectedExitCode?: number;
  readonly healthTimeoutMs?: number;
  readonly timeoutMs?: number;
}

export function runChild(options: ReadModelChildOptions): Promise<unknown>;
