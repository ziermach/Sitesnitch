import { hostOf } from './url.js';

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

  constructor(private readonly limit: number) {}

  /** Runs `fn` once this origin has a free slot, and releases the slot afterwards. */
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const host = hostOf(url) ?? 'unknown';
    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
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
