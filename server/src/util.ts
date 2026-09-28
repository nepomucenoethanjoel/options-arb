export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple async token bucket: enforces a minimum interval between calls plus a
 * sliding-window cap. Derive public limits are 5 TPS / 25 requests per 5s per
 * IP — we stay deliberately under (≈4.7 TPS, 24/5s).
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly minIntervalMs: number,
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      const last = this.timestamps.length > 0 ? this.timestamps[this.timestamps.length - 1] : 0;
      const waitInterval = this.timestamps.length > 0 ? Math.max(0, last + this.minIntervalMs - now) : 0;
      const waitWindow =
        this.timestamps.length >= this.maxPerWindow
          ? Math.max(0, this.timestamps[0] + this.windowMs - now)
          : 0;
      const wait = Math.max(waitInterval, waitWindow);
      if (wait === 0) {
        this.timestamps.push(now);
        return;
      }
      await sleep(wait);
    }
  }
}

/** Health state tracker shared by adapters. */
export class HealthTracker {
  private lastSuccessTs: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly venue: 'derive' | 'olive',
    private readonly source: string,
    private readonly staleMs: number,
  ) {}

  ok() {
    this.lastSuccessTs = Date.now();
    this.lastError = null;
  }

  fail(err: unknown) {
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  snapshot() {
    const now = Date.now();
    let status: 'ok' | 'stale' | 'error' | 'unknown';
    if (this.lastSuccessTs == null) {
      status = this.lastError != null ? 'error' : 'unknown';
    } else if (now - this.lastSuccessTs > this.staleMs) {
      status = this.lastError != null ? 'error' : 'stale';
    } else {
      status = 'ok';
    }
    return {
      venue: this.venue,
      source: this.source,
      status,
      lastSuccessTs: this.lastSuccessTs,
      lastError: this.lastError,
    };
  }
}
