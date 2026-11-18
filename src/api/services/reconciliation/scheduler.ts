/**
 * Disposable keyed scheduling. The caller owns discovery, deadlines, timers,
 * and the complete operation (including error handling and post-work refresh).
 */
export class Scheduler<
  T extends { readonly dueAt: number },
  Lane extends string,
> {
  private readonly scheduled = new Map<string, Readonly<T>>();
  private readonly active = new Map<string, Promise<void>>();
  private laneCursor = 0;
  private pumping = false;

  constructor(
    private readonly options: {
      laneCycle: readonly Lane[];
      maxInFlight: number;
      key: (entry: Readonly<T>) => string;
      lane: (entry: Readonly<T>) => Lane;
      now: () => number;
      shouldRefill: () => boolean;
      run: (entry: Readonly<T>) => Promise<void>;
    },
  ) {}

  /** Installing a schedule moves the key to the tail, even while it is active. */
  replace(input: T): Readonly<T> {
    // A fresh identity also distinguishes repeated installs of the same input.
    const entry = Object.freeze({ ...input });
    const key = this.options.key(entry);
    this.scheduled.delete(key);
    this.scheduled.set(key, entry);
    return entry;
  }

  get(key: string): Readonly<T> | undefined {
    return this.scheduled.get(key);
  }

  entries(): readonly Readonly<T>[] {
    return [...this.scheduled.values()];
  }

  get entryCount(): number {
    return this.scheduled.size;
  }

  remove(key: string): void {
    this.scheduled.delete(key);
  }

  isCurrent(entry: Readonly<T>): boolean {
    return this.scheduled.get(this.options.key(entry)) === entry;
  }

  replaceIfCurrent(expected: Readonly<T>, input: T): Readonly<T> | undefined {
    if (!this.isCurrent(expected)) return undefined;
    if (this.options.key(input) !== this.options.key(expected)) {
      throw new Error('A conditional schedule replacement must keep its key');
    }
    return this.replace(input);
  }

  removeIfCurrent(expected: Readonly<T>): boolean {
    if (!this.isCurrent(expected)) return false;
    this.remove(this.options.key(expected));
    return true;
  }

  hasInFlight(key: string): boolean {
    return this.active.has(key);
  }

  get inFlightCount(): number {
    return this.active.size;
  }

  pump(restrictTo?: ReadonlySet<string>): readonly Readonly<T>[] {
    if (this.pumping) return [];
    this.pumping = true;
    try {
      const available = this.options.maxInFlight - this.active.size;
      if (available <= 0) return [];
      const selected = this.selectDue(available, restrictTo);
      for (const entry of selected) this.launch(entry);
      return selected;
    } finally {
      this.pumping = false;
    }
  }

  /** Wait for the current snapshot, including each operation's slot release. */
  waitForInFlight(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...this.active.values()]);
  }

  backlog(): {
    scheduledCount: number;
    inFlightCount: number;
    oldestDueAgeMs: number;
  } {
    const now = this.options.now();
    let scheduledCount = 0;
    let oldestDueAgeMs = 0;
    for (const entry of this.scheduled.values()) {
      if (this.active.has(this.options.key(entry))) continue;
      scheduledCount += 1;
      if (entry.dueAt <= now) {
        oldestDueAgeMs = Math.max(oldestDueAgeMs, now - entry.dueAt);
      }
    }
    return {
      scheduledCount,
      inFlightCount: this.active.size,
      oldestDueAgeMs,
    };
  }

  private selectDue(
    limit: number,
    restrictTo?: ReadonlySet<string>,
  ): Readonly<T>[] {
    const now = this.options.now();
    const { laneCycle } = this.options;
    const byLane = new Map<Lane, Readonly<T>[]>();
    for (const lane of laneCycle) {
      if (!byLane.has(lane)) byLane.set(lane, []);
    }
    for (const entry of this.scheduled.values()) {
      const key = this.options.key(entry);
      if (
        this.active.has(key) ||
        entry.dueAt > now ||
        (restrictTo && !restrictTo.has(key))
      ) {
        continue;
      }
      byLane.get(this.options.lane(entry))!.push(entry);
    }

    const selected: Readonly<T>[] = [];
    let cursor = this.laneCursor;
    while (selected.length < limit) {
      let next: Readonly<T> | undefined;
      for (let offset = 0; offset < laneCycle.length; offset += 1) {
        const cycleIndex = (cursor + offset) % laneCycle.length;
        const lane = laneCycle[cycleIndex]!;
        const candidate = byLane.get(lane)!.shift();
        if (!candidate) continue;
        next = candidate;
        cursor = (cycleIndex + 1) % laneCycle.length;
        break;
      }
      if (!next) break;
      selected.push(next);
    }
    this.laneCursor = cursor;
    return selected;
  }

  private launch(entry: Readonly<T>): void {
    const key = this.options.key(entry);
    if (this.active.has(key)) return;
    const promise = this.options.run(entry).finally(() => {
      this.active.delete(key);
      if (this.options.shouldRefill()) this.pump();
    });
    this.active.set(key, promise);
  }
}
