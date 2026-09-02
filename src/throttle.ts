import { hostOf } from './url.js';

/**
 * Reads a Retry-After header, in either of its two legal forms (delta-seconds, or an
 * HTTP-date). Returns undefined when absent or unparseable — never a zero, which would read
 * as "the server said go right ahead".
 */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - Date.now());
}

export interface BackoffPolicy {
  /** Cooldown after a host's first 429. Doubles per consecutive strike. */
  baseMs: number;
  /** Ceiling on a single cooldown, however many strikes or however long a Retry-After. */
  maxMs: number;
  /** A host quiet for this long is forgiven its strikes. */
  forgetMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 10_000,
  maxMs: 60_000,
  forgetMs: 300_000,
};

/**
 * Caps how many requests are in flight against any single origin at once.
 *
 * A global concurrency limit is not enough, and believing otherwise is what let an earlier
 * build hammer a production site into timing out. Almost every URL this crawler touches
 * lives on one host, so "16 concurrent requests" and "16 concurrent requests *to that one
 * host*" are the same number in practice. This is the limit that actually protects the site.
 *
 * A queue per host, each draining at most `limit` at a time. Requests to different hosts
 * (a docs subdomain, an external link) never queue behind each other.
 */
export class PerOriginThrottle {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly strikes = new Map<string, { count: number; at: number }>();

  constructor(
    private readonly limit: number,
    private readonly backoff: BackoffPolicy = DEFAULT_BACKOFF,
  ) {}

  /** Runs `fn` once this origin has a free slot and any cooldown has elapsed. */
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const host = hostOf(url) ?? 'unknown';
    await this.acquire(host);
    try {
      await this.awaitCooldown(host);
      return await fn();
    } finally {
      this.release(host);
    }
  }

  /**
   * Records that this origin told us to slow down, and returns how long everything bound
   * for it will now wait. Retry-After is honoured when the server sends one, capped.
   *
   * The standing warning in CLAUDE.md is that a 429 will *not* arrive to save you — a
   * server under pressure simply stops answering. It is not the converse: one observed site sent
   * 484 of them in one run and the crawler kept the same pace regardless, which is how 485
   * pages ended up unmeasured. When a host does ask, obeying is free.
   */
  penalize(url: string, retryAfterMs?: number): number {
    const host = hostOf(url) ?? 'unknown';
    const now = Date.now();

    const previous = this.strikes.get(host);
    const count = previous && now - previous.at < this.backoff.forgetMs ? previous.count + 1 : 1;
    this.strikes.set(host, { count, at: now });

    const exponential = this.backoff.baseMs * 2 ** (count - 1);
    const waitMs = Math.min(Math.max(exponential, retryAfterMs ?? 0), this.backoff.maxMs);

    // Never shorten a cooldown another 429 already bought: concurrent workers hit the same
    // wall at the same moment, and the longest verdict is the one that should stand.
    this.cooldownUntil.set(host, Math.max(this.cooldownUntil.get(host) ?? 0, now + waitMs));
    return waitMs;
  }

  /** Milliseconds a request to this URL would currently wait before being sent. */
  cooldownRemaining(url: string): number {
    const until = this.cooldownUntil.get(hostOf(url) ?? 'unknown') ?? 0;
    return Math.max(0, until - Date.now());
  }

  /**
   * Waits out the host's cooldown while *holding* its slot.
   *
   * Holding is deliberate: it caps how many requests pile up behind the cooldown at the
   * per-origin limit, so the moment it expires the host sees `limit` requests, not the
   * whole queue at once. Looping re-reads the deadline, which a concurrent 429 may extend.
   */
  private async awaitCooldown(host: string): Promise<void> {
    for (;;) {
      const until = this.cooldownUntil.get(host);
      if (!until) return;
      const remaining = until - Date.now();
      if (remaining <= 0) {
        this.cooldownUntil.delete(host);
        return;
      }
      await new Promise((r) => setTimeout(r, remaining));
    }
  }

  private async acquire(host: string): Promise<void> {
    const inFlight = this.active.get(host) ?? 0;

    if (inFlight < this.limit) {
      this.active.set(host, inFlight + 1);
      return;
    }

    await new Promise<void>((resolve) => {
      const queue = this.waiting.get(host) ?? [];
      queue.push(resolve);
      this.waiting.set(host, queue);
    });
  }

  private release(host: string): void {
    const queue = this.waiting.get(host);
    const next = queue?.shift();

    if (next) {
      // Hand the slot straight to the next waiter — the in-flight count is unchanged, so
      // it must not be decremented here or the limit would drift upward over time.
      next();
      return;
    }

    const inFlight = this.active.get(host) ?? 1;
    if (inFlight <= 1) this.active.delete(host);
    else this.active.set(host, inFlight - 1);
  }
}
