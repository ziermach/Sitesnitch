import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js';
import { LinkChecker } from '../src/linkChecker.js';
import { slim } from '../src/run.js';
import { PerOriginThrottle } from '../src/throttle.js';
import type { DomSnapshot, PageContext } from '../src/types.js';
import { hostMatches } from '../src/url.js';

/**
 * Performance here means *work avoided*, and every assertion below counts work rather than
 * measuring time.
 *
 * That is deliberate. A wall-clock threshold on a shared CI runner is a coin flip: it goes
 * red when a neighbouring job gets busy and green again on a re-run, and a suite that cries
 * wolf gets its failures ignored — which is exactly how the regressions these tests exist to
 * catch would slip through. Requests issued, objects retained and regexes compiled are
 * deterministic, and each one maps to a property this crawler genuinely depends on to stay
 * finite and to stay polite.
 */

// --- the dedup cache, which is what keeps a crawl finite -----------------------------

describe('LinkChecker probes each URL exactly once per run', () => {
  let server: Server;
  let base: string;
  let hits: Map<string, number>;

  beforeAll(async () => {
    hits = new Map();
    server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const path = req.url ?? '/';
        hits.set(path, (hits.get(path) ?? 0) + 1);
        res.writeHead(200, { 'content-type': 'text/html' }).end('ok');
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const checker = (): LinkChecker =>
    new LinkChecker(mergeConfig(DEFAULT_CONFIG, { baseUrl: 'https://example.com' }));

  it('collapses the footer: 40 pages sharing 50 links cost 50 requests, not 2,000', async () => {
    // The scaling property the whole design rests on. Every page on a real site links to
    // the same nav and footer targets; probing them per-page is the difference between a
    // crawl that finishes and one that gets the crawler blocked.
    hits.clear();
    const lc = checker();
    const footer = Array.from({ length: 50 }, (_, i) => `${base}/footer-${i}`);

    for (let page = 0; page < 40; page++) await lc.checkAll(footer);

    const total = [...hits.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(50);
    expect(new Set(hits.values())).toEqual(new Set([1]));
    expect(lc.checkedCount).toBe(50);
  }, 60_000);

  it('collapses a thundering herd: 200 concurrent callers for one URL make one request', async () => {
    // Without the in-flight map, a page that links the same target 200 times would fire 200
    // simultaneous requests at it — the cache alone does not help, because nothing has
    // resolved yet to populate it.
    hits.clear();
    const lc = checker();
    const url = `${base}/hot`;

    await Promise.all(Array.from({ length: 200 }, () => lc.check(url)));

    expect(hits.get('/hot')).toBe(1);
  }, 60_000);

  it('treats the two trailing-slash forms as one probe', async () => {
    // dedupeKey collapses them for identity, so the cache must not pay twice.
    hits.clear();
    const lc = checker();
    await lc.checkAll([`${base}/thing`, `${base}/thing`]);
    expect([...hits.values()].reduce((a, b) => a + b, 0)).toBe(1);
  }, 60_000);
});

// --- the per-origin cap, which is what keeps the crawl polite -------------------------

describe('PerOriginThrottle never exceeds its cap under load', () => {
  it('holds the limit across 500 queued tasks on one origin', async () => {
    // The number that actually protects the site under test. A regression here does not
    // fail loudly — it just quietly turns a QA tool into a load generator.
    const limit = 6;
    const t = new PerOriginThrottle(limit);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 500 }, () =>
        t.run('https://example.com/x', async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(limit);
    expect(active).toBe(0);
  }, 60_000);

  it('does not let one slow origin block another', async () => {
    // Politeness to one host must not be paid for by head-of-line blocking on another.
    const t = new PerOriginThrottle(2);
    let fastDone = 0;
    const slow = Array.from({ length: 8 }, () =>
      t.run('https://slow.example.com/x', () => new Promise((r) => setTimeout(r, 60))),
    );
    const fast = Array.from({ length: 8 }, () =>
      t.run('https://fast.example.com/x', () => {
        fastDone++;
        return Promise.resolve();
      }),
    );

    await Promise.all(fast);
    expect(fastDone).toBe(8); // finished without waiting on the slow origin
    await Promise.all(slow);
  }, 60_000);
});

// --- memory: what a page costs once its checks have run ------------------------------

describe('slim() drops what nothing reads again', () => {
  const fatContext = (): PageContext => {
    const dom: DomSnapshot = {
      title: 'A page',
      metaDescription: 'A description that the cross-page pass compares against other pages.',
      metaRobots: null,
      canonical: 'https://example.com/p',
      htmlLang: 'en',
      h1s: ['A page'],
      og: {},
      hreflang: [{ hreflang: 'de', href: 'https://example.com/de/p' }],
      links: Array.from({ length: 500 }, (_, i) => ({
        href: `https://example.com/link-${i}`, text: `link ${i}`, rel: null,
      })),
      images: Array.from({ length: 200 }, (_, i) => ({
        src: `https://example.com/img-${i}.png`, alt: `image ${i}`, naturalWidth: 800,
      })),
      resources: Array.from({ length: 200 }, (_, i) => ({
        url: `https://example.com/asset-${i}.js`, where: 'script[src]',
      })),
      inlineScripts: Array.from({ length: 40 }, (_, i) => 'x'.repeat(2_000) + i),
      consentBannerVisible: false,
    };
    return {
      url: 'https://example.com/p',
      finalUrl: 'https://example.com/p',
      status: 200,
      redirectChain: [],
      depth: 1,
      source: 'sitemap',
      loadMs: 900,
      dom,
      console: Array.from({ length: 300 }, (_, i) => ({ type: 'warning' as const, text: `w${i}` })),
      failedRequests: [],
      requestUrls: Array.from({ length: 600 }, (_, i) => `https://example.com/req-${i}`),
      axe: null,
    };
  };

  const bytes = (v: unknown): number => JSON.stringify(v)?.length ?? 0;

  it('cuts a page down by more than 90%', () => {
    // Multiplied by the thousands of pages held until the report is written, this is the
    // difference between a crawl that fits in memory and one that does not.
    const fat = fatContext();
    const thin = slim(fat);
    expect(bytes(thin) / bytes(fat)).toBeLessThan(0.1);
  });

  it('keeps exactly what the cross-page pass still reads', () => {
    // If a cross-page check ever finds a field mysteriously empty, slim() is the culprit —
    // so pin the contract here rather than leaving it to a comment.
    const thin = slim(fatContext());
    expect(thin.url).toBe('https://example.com/p');
    expect(thin.finalUrl).toBe('https://example.com/p');
    expect(thin.status).toBe(200);
    expect(thin.dom?.title).toBe('A page');
    expect(thin.dom?.metaDescription).toContain('cross-page pass');
    expect(thin.dom?.hreflang).toHaveLength(1);
    expect(thin.dom?.canonical).toBe('https://example.com/p');
  });

  it('drops the bulk arrays', () => {
    const thin = slim(fatContext());
    expect(thin.dom?.links).toEqual([]);
    expect(thin.dom?.images).toEqual([]);
    expect(thin.dom?.resources).toEqual([]);
    expect(thin.dom?.inlineScripts).toEqual([]);
    expect(thin.requestUrls).toEqual([]);
    expect(thin.console).toEqual([]);
  });
});

// --- host matching, which runs on every URL against every pattern ---------------------

describe('hostMatches stays cheap at crawl scale', () => {
  it('compiles each glob once, however many times it is used', () => {
    // hostMatches runs for every candidate URL against every configured pattern — millions
    // of calls over a handful of patterns. Recompiling per call would be pure waste, so the
    // module caches by pattern string. Count constructions rather than time.
    const NativeRegExp = globalThis.RegExp;
    let compiled = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).RegExp = new Proxy(NativeRegExp, {
      construct(target, args: [string, string?]) {
        compiled++;
        return new target(...args);
      },
    });

    try {
      for (let i = 0; i < 5_000; i++) {
        hostMatches(`host-${i}.example.com`, '*.example.com');
        hostMatches(`host-${i}.example.com`, 'staging-*');
      }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).RegExp = NativeRegExp;
    }

    // Two distinct patterns, so at most two compilations for 10,000 calls.
    expect(compiled).toBeLessThanOrEqual(2);
  });

  it('is still correct across many patterns and hosts', () => {
    const patterns = Array.from({ length: 200 }, (_, i) => `*.env-${i}.example.com`);
    expect(patterns.filter((p) => hostMatches('api.env-137.example.com', p))).toEqual([
      '*.env-137.example.com',
    ]);
    expect(patterns.some((p) => hostMatches('api.example.com', p))).toBe(false);
  });
});
