import { Agent, setGlobalDispatcher } from 'undici';
import type { ResolvedConfig } from './config.js';
import { PerOriginThrottle } from './throttle.js';
import type { LinkStatus } from './types.js';
import { normalizeUrl } from './url.js';

/**
 * Sizes Node's HTTP connection pool to match the throttle.
 *
 * undici (which backs `fetch`) opens only a few sockets per origin by default, and our
 * abort timer starts when fetch() is *called*, not when the request is actually sent. So a
 * probe could burn its whole 15s timeout waiting in undici's internal queue and be reported
 * "unreachable" without a packet ever leaving the machine — 1,321 phantom dead links on a
 * site whose links were fine.
 *
 * The lesson learned the hard way: the answer is NOT to open the pool wide. Doing that
 * simply moved the pile-up from our queue onto the server's accept queue, and the site
 * started timing out for real (and, presumably, for its real visitors). The pool is sized to
 * PerOriginThrottle's limit, so requests wait in *our* queue — where waiting is free and
 * harms nobody — rather than in the site's.
 */
let poolConfigured = false;
function configureConnectionPool(connections: number): void {
  if (poolConfigured) return;
  poolConfigured = true;

  setGlobalDispatcher(
    new Agent({
      connections,
      pipelining: 1,
      connectTimeout: 10_000,
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    }),
  );
}

/**
 * Deduplicated status probe for every URL the site points at.
 *
 * This is what keeps the run finite. The site has a footer: every one of the thousands
 * of pages links to the same ~50 targets. Without a cache we'd probe each of them
 * thousands of times, and get rate-limited for our trouble. Each URL is probed once,
 * ever, and concurrent callers for the same URL share the one in-flight promise.
 */
export class LinkChecker {
  private readonly cache = new Map<string, LinkStatus>();
  private readonly inFlight = new Map<string, Promise<LinkStatus>>();

  private readonly throttle: PerOriginThrottle;

  constructor(private readonly config: ResolvedConfig) {
    this.throttle = new PerOriginThrottle(config.perOriginConcurrency);
    // Sized to the per-origin cap, not above it: queuing belongs on our side of the wire.
    configureConnectionPool(config.perOriginConcurrency);
  }

  get checkedCount(): number {
    return this.cache.size;
  }

  get(url: string): LinkStatus | undefined {
    const normalized = normalizeUrl(url);
    return normalized ? this.cache.get(normalized) : undefined;
  }

  all(): LinkStatus[] {
    return [...this.cache.values()];
  }

  async check(rawUrl: string): Promise<LinkStatus | undefined> {
    const url = normalizeUrl(rawUrl);
    if (!url) return undefined;

    const cached = this.cache.get(url);
    if (cached) return cached;

    const pending = this.inFlight.get(url);
    if (pending) return pending;

    const promise = this.probeWithRetry(url).then((status) => {
      this.cache.set(url, status);
      this.inFlight.delete(url);
      return status;
    });
    this.inFlight.set(url, promise);
    return promise;
  }

  /**
   * Declaring a link dead is an accusation, so we make it twice before we make it at all.
   *
   * A transient timeout or connection reset — a hiccup, a momentary rate-limit — is not a
   * broken link, but it is indistinguishable from one on a single attempt. Retrying only
   * the failures costs nothing on a healthy site (nothing to retry) and is what keeps
   * "unreachable" from becoming the noise that trains everyone to ignore the report.
   */
  private async probeWithRetry(url: string): Promise<LinkStatus> {
    const first = await this.probe(url);
    if (first.status !== 0) return first;

    await new Promise((r) => setTimeout(r, 1_000));

    const second = await this.probe(url);
    if (second.status !== 0) return second;

    return { ...second, error: `${second.error ?? 'request failed'} (retried once)` };
  }

  async checkAll(urls: string[], concurrency = this.config.linkConcurrency): Promise<void> {
    const queue = [...new Set(urls)];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const url = queue.shift();
        if (!url) return;
        await this.check(url);
      }
    });
    await Promise.all(workers);
  }

  /**
   * HEAD first — we only need the status line, and pulling the body of every target on
   * the site would be gratuitous. But plenty of servers (and CDNs, and WAFs) either don't
   * implement HEAD or treat it as suspicious, so a 4xx/5xx from HEAD is retried with GET
   * before we call a link dead. Reporting a false 404 is worse than one extra request.
   *
   * Every response body MUST be released. `fetch()` resolves as soon as the headers land,
   * and undici keeps the socket checked out of the pool until the body is read or
   * cancelled. We only ever look at the status, so without an explicit cancel each probe
   * leaks a connection; the pool then saturates and the whole crawl grinds to a crawl
   * behind its own held-open sockets. (It presents as "the network got slow" — it isn't.)
   */
  private async probe(url: string): Promise<LinkStatus> {
    const started = Date.now();

    /**
     * The timeout clock starts INSIDE the throttle, never outside it.
     *
     * This is the whole point. If the timer were started before waiting for a slot, a probe
     * could exhaust its 15s budget queueing behind our own politeness and be reported dead
     * without a request ever being sent — which is precisely the bug the throttle exists to
     * prevent. `linkTimeout` must mean "the server took too long", not "we were busy".
     */
    const attempt = (method: 'HEAD' | 'GET'): Promise<Response> =>
      this.throttle.run(url, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.linkTimeout);
        try {
          return await fetch(url, {
            method,
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': this.config.userAgent, Accept: '*/*' },
          });
        } finally {
          clearTimeout(timer);
        }
      });

    /** Returns the socket to the pool without downloading the body. */
    const release = async (response: Response): Promise<void> => {
      await response.body?.cancel().catch(() => undefined);
    };

    try {
      let response = await attempt('HEAD');

      if (response.status >= 400 || response.status === 0) {
        await release(response);
        response = await attempt('GET');
      }

      const finalUrl = normalizeUrl(response.url) ?? url;
      const status = response.status;
      const redirected = response.redirected;
      await release(response);

      return {
        url,
        status,
        finalUrl: finalUrl !== url ? finalUrl : undefined,
        // fetch() follows redirects but won't tell us how many hops it took. `redirected`
        // is all we get, so a redirect counts as 1 hop; the browser-side crawl reports the
        // true chain length for pages we actually navigate to.
        redirects: redirected ? 1 : 0,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      return {
        url,
        status: 0,
        redirects: 0,
        error: isTimeout ? `timeout after ${this.config.linkTimeout}ms` : message,
        durationMs: Date.now() - started,
      };
    }
  }

}
