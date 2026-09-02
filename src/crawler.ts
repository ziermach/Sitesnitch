import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import type { ResolvedConfig } from './config.js';
import { dismissConsent, seedConsent } from './consent.js';
import type { Frontier } from './frontier.js';
import type {
  AxeViolation,
  ConsoleEntry,
  DomSnapshot,
  FailedRequest,
  PageContext,
} from './types.js';

export interface CrawlHooks {
  onPage: (ctx: PageContext) => Promise<void> | void;
  onProgress?: (done: number, queued: number) => void;
}

/** Resolved once: axe's bundle is ~600 KB and is injected into every page we audit. */
const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/**
 * Drives Chromium over the frontier.
 *
 * One browser, N contexts. Each context is a clean session (own cookies, own storage),
 * which keeps workers from stepping on each other's consent state, and each worker
 * reuses its context across pages so we're not paying context-creation cost per URL.
 */
export class Crawler {
  private browser: Browser | null = null;
  private done = 0;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly frontier: Frontier,
  ) {}

  async run(hooks: CrawlHooks): Promise<void> {
    this.browser = await chromium.launch({ headless: true });

    try {
      const workers = Array.from({ length: this.config.concurrency }, (_, i) =>
        this.worker(i, hooks),
      );
      await Promise.all(workers);
    } finally {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async worker(_id: number, hooks: CrawlHooks): Promise<void> {
    const context = await this.browser!.newContext({
      userAgent: this.config.userAgent,
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: false,
    });
    await installEsbuildNameShim(context);
    await seedConsent(context, this.config.baseUrl);

    try {
      for (;;) {
        const item = this.frontier.next();
        if (!item) return;

        const ctx = await this.visit(context, item.url, item.depth, item.source);
        this.done++;
        await hooks.onPage(ctx);
        hooks.onProgress?.(this.done, this.frontier.size);

        if (this.config.delayMs > 0) {
          await new Promise((r) => setTimeout(r, this.config.delayMs));
        }
      }
    } finally {
      await context.close();
    }
  }

  /** Loads one page and records everything a check could possibly need. */
  private async visit(
    context: BrowserContext,
    url: string,
    depth: number,
    source: string,
  ): Promise<PageContext> {
    const page = await context.newPage();

    const consoleEntries: ConsoleEntry[] = [];
    const failedRequests: FailedRequest[] = [];
    const requestUrls: string[] = [];

    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;

      const text = msg.text();
      // The browser logs a generic "Failed to load resource: …404" line for every failed
      // request. We already capture those from the response/requestfailed events, with the
      // URL and method attached. Keeping both would report each broken asset twice, and
      // the console copy is the less useful of the two.
      if (/^Failed to load resource:/.test(text)) return;

      const loc = msg.location();
      consoleEntries.push({
        type,
        text,
        location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
      });
    });

    // Uncaught exceptions do not always surface as console messages — a thrown Error in a
    // promise chain hits 'pageerror' and nothing else. Without this listener, real JS
    // breakage goes unreported.
    page.on('pageerror', (err) => {
      consoleEntries.push({ type: 'pageerror', text: err.message, location: err.stack });
    });

    page.on('request', (req) => {
      requestUrls.push(req.url());
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'unknown';
      // Not a defect: the browser aborts in-flight requests on navigation, and consent
      // tooling deliberately blocks trackers. Reporting those would bury the real failures.
      if (failure.includes('ERR_ABORTED') || failure.includes('NS_BINDING_ABORTED')) return;
      failedRequests.push({
        url: req.url(),
        status: 0,
        method: req.method(),
        resourceType: req.resourceType(),
        failure,
      });
    });

    page.on('response', (res) => {
      if (res.status() < 400) return;

      // The page's own document is not a subresource. Its status is the http-status
      // check's job; reporting it here too would mean a 404 page files three issues for
      // one problem.
      const request = res.request();
      if (request.isNavigationRequest() && res.frame() === page.mainFrame()) return;

      failedRequests.push({
        url: res.url(),
        status: res.status(),
        method: request.method(),
        resourceType: request.resourceType(),
      });
    });

    const started = Date.now();
    let response: Response | null = null;
    let navigationError: string | undefined;

    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.requestTimeout,
      });
      // Give late-firing scripts a chance to throw and late XHRs a chance to fire — a
      // staging-host call made from JS after load is exactly the leak we're hunting.
      // Timing out here is the normal case, not an error: ad and analytics traffic means
      // many pages never reach a genuinely idle network.
      await page
        .waitForLoadState('networkidle', { timeout: this.config.settleMs })
        .catch(() => undefined);
    } catch (err) {
      navigationError = err instanceof Error ? err.message : String(err);
    }

    const loadMs = Date.now() - started;

    let dom: DomSnapshot | null = null;
    let domError: string | undefined;
    let consentBannerVisible = false;

    if (!navigationError) {
      consentBannerVisible = await dismissConsent(page).catch(() => false);

      // A failure here is not "the page was fine". It means seo, links, images,
      // mixed-content and the DOM half of forbidden-hosts all silently found nothing on
      // this page. Record why, so it surfaces as an issue instead of as a clean result.
      try {
        dom = await extractDom(page);
        dom.consentBannerVisible = consentBannerVisible;
      } catch (err) {
        domError = err instanceof Error ? err.message : String(err);
      }
    }

    let axe: AxeViolation[] | null = null;
    let axeError: string | undefined;

    // Deliberately after dismissConsent(): a consent overlay is a focus trap and a huge
    // contrast surface of its own, so auditing with it up measures the cookie banner's
    // accessibility rather than the site's.
    if (!navigationError && this.config.checks.includes('accessibility')) {
      try {
        axe = await runAxe(page);
      } catch (err) {
        axeError = err instanceof Error ? err.message : String(err);
      }
    }

    const redirectChain = response ? buildRedirectChain(response) : [];

    await page.close();

    return {
      url,
      finalUrl: response ? response.url() : url,
      status: response ? response.status() : 0,
      redirectChain,
      depth,
      source,
      loadMs,
      dom,
      console: consoleEntries,
      failedRequests,
      requestUrls,
      axe,
      axeError,
      navigationError,
      domError,
    };
  }
}

/**
 * Makes `page.evaluate()` survive the TypeScript transform.
 *
 * esbuild — which tsx and vitest both use — compiles named functions with a `__name(fn,
 * "fn")` call to preserve `fn.name`, and defines that helper at module scope. Playwright
 * serializes an evaluate callback to source text and runs it in the browser, where the
 * module scope doesn't exist, so every helper inside extractDom() blows up with
 * "ReferenceError: __name is not defined" and the whole snapshot comes back null.
 *
 * The failure is silent and total: no DOM means no SEO, links, images, mixed-content or
 * DOM-side forbidden-host findings — the crawler reports a clean site while measuring
 * nothing. Defining the helper as a no-op in the page fixes it for every evaluate we run.
 */
export async function installEsbuildNameShim(context: BrowserContext): Promise<void> {
  // Passed as raw source, not a function: a function would itself go through the very
  // transform we're compensating for.
  await context.addInitScript({ content: 'globalThis.__name ??= (fn) => fn;' });
}

/** A page can violate one rule (say, colour-contrast) on hundreds of elements. */
const MAX_AXE_NODES = 8;

/**
 * Runs axe-core against the live page.
 *
 * Accessibility cannot be audited from HTML source, which is exactly why it belongs here
 * rather than in a static check: colour contrast needs computed styles, focus order needs
 * layout, and ARIA state needs the script that sets it to have run. axe is injected into
 * the page it audits.
 *
 * Scoped to the WCAG 2.1 A/AA success criteria — the level the European Accessibility Act
 * and most procurement rules actually require. axe's "best-practice" rules are deliberately
 * excluded: they are opinions, not obligations, and mixing them in would let a genuine
 * WCAG failure hide behind a hundred stylistic notes.
 */
async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });

  const violations = await page.evaluate(async (maxNodes) => {
    // axe attaches itself to window; axe-core's own types describe what it puts there.
    const { axe } = window as unknown as { axe: typeof import('axe-core') };

    const result = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
      reporter: 'v1',
    });

    return result.violations.map((v) => ({
      id: v.id,
      // axe types impact as nullable; a violation without one is still a violation.
      impact: v.impact ?? 'minor',
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.slice(0, maxNodes).map((n) => n.target.join(' ')),
      nodeCount: v.nodes.length,
      failureSummary: v.nodes[0]?.failureSummary,
    }));
  }, MAX_AXE_NODES);

  return violations;
}

/** Walks `redirectedFrom()` backwards to reconstruct the hops that led here. */
function buildRedirectChain(response: Response): string[] {
  const chain: string[] = [];
  let request = response.request().redirectedFrom();
  while (request) {
    chain.unshift(request.url());
    request = request.redirectedFrom();
  }
  return chain;
}

/**
 * Reads the whole DOM in one round-trip.
 *
 * Every `page.$$eval` is an IPC hop to the browser process; doing a dozen of them per
 * page, across thousands of pages, costs real minutes. One evaluate, one hop.
 */
async function extractDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const abs = (value: string | null): string => {
      if (!value) return '';
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };

    const meta = (name: string): string | null =>
      document.querySelector<HTMLMetaElement>(`meta[name="${name}" i]`)?.content?.trim() ?? null;

    const og: Record<string, string> = {};
    for (const el of document.querySelectorAll<HTMLMetaElement>('meta[property^="og:" i]')) {
      const key = el.getAttribute('property');
      if (key && el.content) og[key.toLowerCase()] = el.content.trim();
    }

    const resources: Array<{ url: string; where: string }> = [];
    const collect = (selector: string, attr: string, where: string) => {
      for (const el of document.querySelectorAll(selector)) {
        const raw = el.getAttribute(attr);
        if (!raw) continue;
        // srcset holds a comma-separated candidate list, each `url [descriptor]`.
        if (attr === 'srcset') {
          for (const candidate of raw.split(',')) {
            const url = candidate.trim().split(/\s+/)[0];
            if (url) resources.push({ url: abs(url), where });
          }
        } else {
          resources.push({ url: abs(raw), where });
        }
      }
    };

    collect('script[src]', 'src', 'script[src]');
    collect('iframe[src]', 'src', 'iframe[src]');
    collect('img[srcset]', 'srcset', 'img[srcset]');
    collect('source[srcset]', 'srcset', 'source[srcset]');
    collect('source[src]', 'src', 'source[src]');
    collect('video[src]', 'src', 'video[src]');
    collect('link[href]', 'href', 'link[href]');
    collect('form[action]', 'action', 'form[action]');
    collect('img[src]', 'src', 'img[src]');

    const inlineScripts: string[] = [];
    for (const el of document.querySelectorAll('script:not([src])')) {
      const text = el.textContent?.trim();
      if (text) inlineScripts.push(text);
    }

    return {
      title: document.title?.trim() || null,
      metaDescription: meta('description'),
      metaRobots: meta('robots'),
      canonical:
        document.querySelector<HTMLLinkElement>('link[rel="canonical" i]')?.href?.trim() ?? null,
      htmlLang: document.documentElement.getAttribute('lang'),
      h1s: [...document.querySelectorAll('h1')].map((el) => el.textContent?.trim() ?? ''),
      og,
      hreflang: [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel="alternate" i][hreflang]'),
      ].map((el) => ({
        hreflang: el.getAttribute('hreflang') ?? '',
        href: abs(el.getAttribute('href')),
      })),
      links: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map((el) => ({
        href: abs(el.getAttribute('href')),
        text: (el.textContent ?? '').trim().slice(0, 120),
        rel: el.getAttribute('rel'),
      })),
      images: [...document.querySelectorAll<HTMLImageElement>('img')].map((el) => ({
        src: abs(el.getAttribute('src')),
        alt: el.getAttribute('alt'),
        // 0 after load means the image never decoded — i.e. it's broken. This is the only
        // reliable signal for an <img> whose request 404'd behind a CDN that serves a body.
        naturalWidth: el.complete ? el.naturalWidth : -1,
      })),
      resources,
      inlineScripts,
      consentBannerVisible: false,
    };
  });
}
