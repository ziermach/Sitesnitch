import { join } from 'node:path';

import { runPageChecks } from './checks/index.js';
import { scanTextForForbiddenHosts } from './checks/forbiddenHosts.js';
import { classify } from './classify.js';
import {
  resolveConfig,
  type CrawlerOptions,
  type ResolvedConfig,
} from './config.js';
import { runConsentBannerCheck } from './consentBannerCheck.js';
import { Crawler } from './crawler.js';
import { runCrossPageChecks } from './crossPage.js';
import { Frontier } from './frontier.js';
import { LinkChecker } from './linkChecker.js';
import { parseLlmsTxt, type LlmsTxtDoc } from './llmsTxt.js';
import { writeHtmlReport } from './report/html.js';
import { writeJsonReport } from './report/json.js';
import { ProgressLogger } from './report/progress.js';
import { EMPTY_ROBOTS, parseRobots, type RobotsRules } from './robots.js';
import { fetchSitemapUrls } from './sitemap.js';
import type { CrawlReport, Issue, PageContext, PageResult, Severity } from './types.js';
import { matchesIgnorePattern, normalizeUrl, pathMatches } from './url.js';

/**
 * Callbacks into a running crawl.
 *
 * `log` is the important one: the crawler is chatty by design (a silent tool is
 * indistinguishable from a stuck one, and this one runs for an hour), but a library must
 * not write to somebody else's stdout uninvited. So it defaults to silent and the CLI
 * passes console.log.
 */
export interface CrawlHooks {
  /** Human-readable progress lines. Default: discard. */
  log?: (line: string) => void;
  /** Fired once per page, as soon as its checks have run. */
  onPage?: (result: PageResult) => void;
  /** Fired as the crawl advances: pages finished, URLs still queued. */
  onProgress?: (done: number, queued: number) => void;
}

export interface CrawlOutcome {
  report: CrawlReport;
  /** The configuration the run actually used, defaults filled in. */
  config: ResolvedConfig;
  /**
   * URLs the frontier refused, counted by reason.
   *
   * Surfaced rather than swallowed: a run that quietly skipped 400 URLs on a robots rule
   * must not read as "the whole site is clean".
   */
  skipped: Record<string, number>;
}

/**
 * Crawls a site and returns its report. Writes nothing to disk — see writeReports().
 *
 * This is the whole pipeline (seed → crawl → check → cross-page) with no process-level
 * behaviour in it: no argv, no stdout, no process.exit. The CLI is a thin wrapper that
 * supplies those; anything importing the library gets the same run without them.
 */
export async function runCrawl(
  options: CrawlerOptions,
  hooks: CrawlHooks = {},
): Promise<CrawlOutcome> {
  const config = resolveConfig(options);
  const log = hooks.log ?? ((): void => {});

  enforceTlsVerification(log);

  log(`Crawling ${config.baseUrl}`);
  log(
    `  locales: ${config.locales.join(', ') || '(all)'} · max ${config.maxPages} pages · depth ${config.maxDepth} · concurrency ${config.concurrency}`,
  );
  log(`  checks: ${config.checks.join(', ')}`);
  log('');

  const startedAt = new Date();
  const started = Date.now();

  const robots = config.respectRobots ? await loadRobots(config, log) : EMPTY_ROBOTS;
  if (config.respectRobots && robots.disallow.length > 0) {
    log(`robots.txt: ${robots.disallow.length} disallow rules will be respected`);
  }

  const linkChecker = new LinkChecker(config);
  const frontier = new Frontier(config, robots);

  // --- Seeding ---------------------------------------------------------------
  const { llmsTxt, llmsTxtUrl, llmsIssues } = await loadLlmsTxt(config, log);
  const sitemapUrls = await seedFromSitemap(config, frontier, log);
  seedFromLlmsTxt(config, frontier, llmsTxt);
  frontier.add(config.baseUrl, 0, undefined, 'seed');

  log(`Frontier seeded: ${frontier.acceptedCount} pages queued`);
  log('');

  // llms.txt links get status-checked whether or not they're crawlable pages — a dead
  // external link in that file is still a wrong answer served to every AI agent.
  if (llmsTxt && config.checks.includes('llms-txt')) {
    const urls = llmsTxt.links
      .map((l) => l.url)
      .filter((u) => !matchesIgnorePattern(u, config.ignorePatterns));
    log(`Checking ${urls.length} llms.txt links…`);

    // This phase probes hundreds of URLs before the first page is ever rendered. Without a
    // tick it looks like a hang, which is exactly the impression this crawler should never
    // give — a silent tool is indistinguishable from a stuck one.
    const ticker = setInterval(() => {
      log(`  …${linkChecker.checkedCount}/${urls.length} llms.txt links probed`);
    }, 5_000);
    try {
      await linkChecker.checkAll(urls);
    } finally {
      clearInterval(ticker);
    }
    log(`  done: ${linkChecker.checkedCount} links probed`);
  }

  // --- Crawl -----------------------------------------------------------------
  const pages: PageResult[] = [];
  const crawler = new Crawler(config, frontier);
  const checksEnabled = config.checks;
  const progress = new ProgressLogger(
    () => frontier.size,
    () => linkChecker.checkedCount,
    config.verbose,
    log,
  );

  await crawler.run({
    onPage: async (ctx) => {
      // Feed newly discovered links back into the frontier before checks run, so BFS
      // keeps moving while this page's link statuses are still being probed.
      if (config.followLinks && ctx.dom) {
        for (const link of ctx.dom.links) {
          frontier.add(link.href, ctx.depth + 1, ctx.finalUrl, ctx.finalUrl);
        }
      }

      // Probe every link target on this page. Cached, so shared nav/footer links across
      // thousands of pages cost exactly one request each for the whole run.
      if (checksEnabled.includes('links') && ctx.dom) {
        const targets = ctx.dom.links
          .map((l) => normalizeUrl(l.href))
          .filter((u): u is string => u !== null && !matchesIgnorePattern(u, config.ignorePatterns));
        await linkChecker.checkAll([...new Set(targets)]);
      }

      const issues = await runPageChecks(ctx, checksEnabled, {
        config,
        linkStatus: (url) => linkChecker.get(url),
      });

      // Reported even when the http-status check is switched off. A page we failed to read
      // is a hole in the crawl's coverage, and a hole must never be silent — no --only
      // combination should be able to hide it.
      if (ctx.domError && !issues.some((i) => i.rule === 'dom-extraction-failed')) {
        issues.unshift({
          check: 'http-status',
          severity: 'error',
          rule: 'dom-extraction-failed',
          message: 'Could not read the page DOM — every content check was skipped for this page',
          pageUrl: ctx.url,
          detail: ctx.domError,
        });
      }

      const kept = filterIssues(issues, config);
      progress.page(ctx, kept);

      const result: PageResult = { context: slim(ctx), issues: kept };
      pages.push(result);
      hooks.onPage?.(result);
    },

    onProgress: (done, queued) => {
      // A summary line every 25 pages: rate, ETA, running issue counts. Enough to see the
      // crawl converging (or not) without scrolling back through the per-page lines.
      if (done % 25 === 0) progress.heartbeat(queued);
      hooks.onProgress?.(done, queued);
    },
  });

  log('');

  // --- Cross-page pass -------------------------------------------------------
  const globalIssues: Issue[] = [...llmsIssues];

  if (checksEnabled.includes('cross-page') || checksEnabled.includes('llms-txt')) {
    globalIssues.push(
      ...runCrossPageChecks({
        pages,
        sitemapUrls,
        llmsTxt: checksEnabled.includes('llms-txt') ? llmsTxt : null,
        llmsTxtUrl,
        linkChecker,
        config,
      }).filter((i) => checksEnabled.includes(i.check)),
    );
  }

  // --- Consent-banner pass -----------------------------------------------------
  // A fresh, unseeded browser context per locale root — separate from the main crawl
  // because every worker context there pre-seeds consent (src/consent.ts) so the rest of
  // the checks aren't measuring the overlay instead of the page.
  if (checksEnabled.includes('consent-banner')) {
    log('Checking cookie-consent banner on a fresh session per locale…');
    globalIssues.push(...(await runConsentBannerCheck(config)));
  }

  const finishedAt = new Date();
  const report: CrawlReport = {
    baseUrl: config.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - started,
    pagesCrawled: pages.length,
    linksChecked: linkChecker.checkedCount,
    pages,
    globalIssues,
    counts: countBySeverity([...pages.flatMap((p) => p.issues), ...globalIssues]),
  };

  return { report, config, skipped: frontier.skipCounts };
}

export interface WrittenReports {
  jsonPath: string;
  /** The shared viewer at the reports root. One viewer, one directory per run. */
  htmlPath: string;
  runDir: string;
}

/**
 * Writes report.json and (re)builds the viewer around it.
 *
 * Separate from runCrawl so that a library consumer who only wants the data — to post it
 * to an API, diff it against yesterday's, or fail a build — is not made to litter a
 * directory to get it.
 */
export async function writeReports(
  report: CrawlReport,
  config: ResolvedConfig,
): Promise<WrittenReports> {
  const runDir = join(config.outDir, runNameOf(config));
  const jsonPath = await writeJsonReport(report, runDir);
  const htmlPath = await writeHtmlReport(report, runDir);
  return { jsonPath, htmlPath, runDir };
}

/**
 * Names the run's subdirectory under the reports root.
 *
 * Derived from what was actually crawled, so runs don't silently overwrite each other: a
 * crawl of one sub-site and a crawl of the main site are different reports and belong side
 * by side in the index. `runName` overrides when you want to keep, say, a before/after pair.
 */
export function runNameOf(config: ResolvedConfig): string {
  if (config.runName) return slug(config.runName);
  if (config.includePaths.length > 0) return slug(config.includePaths.join('-'));
  return 'main';
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'run';
}

/**
 * Refuses to inherit a "trust every certificate" setting from the shell.
 *
 * NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification process-wide. A crawler whose
 * whole purpose is to find broken things in production must not be told to trust anything
 * it's handed: with this set, a link to a host with an expired, self-signed or
 * hostname-mismatched certificate comes back a clean 200, and we would report the site
 * healthy while a real visitor gets a full-page browser security warning.
 *
 * We reset it rather than merely warning, because a silently-wrong result is the one
 * outcome this tool exists to prevent. The warning goes to stderr rather than through the
 * `log` hook: a library consumer who muted progress output still needs to hear this one.
 */
function enforceTlsVerification(log: (line: string) => void): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return;

  console.warn(
    'WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 is set in your environment, which disables\n' +
      '         TLS certificate verification for every Node process. Re-enabling it for this\n' +
      '         crawl — otherwise a host with a broken certificate would be reported healthy.\n' +
      '         Consider removing it from your shell profile; it is a machine-wide security\n' +
      '         hole, not just a problem for this tool.\n',
  );
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  log('');
}

/**
 * Keeps only the issues the run was asked about (rules / priorities / categories).
 *
 * Note this filters what is *reported*, not what is *looked for*. `checks` is the lever
 * that makes a run cheap — dropping 'links' skips link probing altogether. A priority
 * filter cannot: a P0 `server-error` is only knowable by fetching the page, so the work
 * happens either way and this just spares you the other 60,000 lines.
 */
function filterIssues(issues: Issue[], config: ResolvedConfig): Issue[] {
  const { rules, priorities, categories } = config;
  if (rules.length === 0 && priorities.length === 0 && categories.length === 0) return issues;

  return issues.filter((issue) => {
    if (rules.length && !rules.includes(issue.rule)) return false;
    if (priorities.length || categories.length) {
      const meta = classify(issue.rule);
      if (priorities.length && !priorities.includes(meta.priority)) return false;
      if (categories.length && !categories.includes(meta.category)) return false;
    }
    return true;
  });
}

/**
 * Strips a page context down to what still has a consumer once its checks have run.
 *
 * A full PageContext holds every link, image, resource, inline script and request URL on
 * the page — easily thousands of strings. Multiplied by the thousands of pages we hold
 * until the report is written, that's the difference between a crawl that fits in memory
 * and one that doesn't, and between a readable report.json and a several-hundred-megabyte
 * one.
 *
 * Anything worth saying about that data is already in `issues` by this point. What's kept
 * is exactly what the cross-page pass still needs: the page's identity, and the metadata
 * it compares across pages (title, description, hreflang).
 */
function slim(ctx: PageContext): PageContext {
  return {
    ...ctx,
    requestUrls: [],
    console: [],
    failedRequests: [],
    dom: ctx.dom
      ? { ...ctx.dom, links: [], images: [], resources: [], inlineScripts: [] }
      : null,
  };
}

// --- seeding -----------------------------------------------------------------

async function loadRobots(
  config: ResolvedConfig,
  log: (line: string) => void,
): Promise<RobotsRules> {
  try {
    const text = await fetchText(new URL('/robots.txt', config.baseUrl).href, config);
    return parseRobots(text);
  } catch (err) {
    log(`Could not load robots.txt (${String(err)}) — proceeding without it`);
    return EMPTY_ROBOTS;
  }
}

async function seedFromSitemap(
  config: ResolvedConfig,
  frontier: Frontier,
  log: (line: string) => void,
): Promise<string[]> {
  if (!config.seedFromSitemap) return [];

  // Don't even fetch a sitemap whose contents are out of scope. A sub-site's index alone
  // can list thousands of URLs that the frontier would then reject one by one.
  const extras = config.extraSitemaps.filter((url) =>
    config.includePaths.length > 0
      ? pathMatches(url, config.includePaths, config.locales)
      : !pathMatches(url, config.excludePaths, config.locales),
  );

  const entries = [new URL('/sitemap.xml', config.baseUrl).href, ...extras];
  const result = await fetchSitemapUrls(entries, (url) => fetchText(url, config));

  for (const { url, error } of result.errors) {
    log(`Sitemap failed to load: ${url} (${error})`);
  }
  log(`Sitemap: ${result.urls.length} URLs from ${result.sitemapsRead.length} files`);

  for (const url of result.urls) frontier.add(url, 0, undefined, 'sitemap');
  return result.urls;
}

async function loadLlmsTxt(
  config: ResolvedConfig,
  log: (line: string) => void,
): Promise<{ llmsTxt: LlmsTxtDoc | null; llmsTxtUrl: string; llmsIssues: Issue[] }> {
  const llmsTxtUrl = new URL('/llms.txt', config.baseUrl).href;
  if (!config.seedFromLlmsTxt) return { llmsTxt: null, llmsTxtUrl, llmsIssues: [] };

  try {
    const text = await fetchText(llmsTxtUrl, config);
    const doc = parseLlmsTxt(text, config.baseUrl);
    log(`llms.txt: ${doc.links.length} links across ${doc.sections.length} sections`);

    // A staging host in llms.txt is handed straight to every AI agent that reads it.
    const llmsIssues = config.checks.includes('forbidden-hosts')
      ? scanTextForForbiddenHosts(text, config.forbiddenHosts, llmsTxtUrl)
      : [];

    return { llmsTxt: doc, llmsTxtUrl, llmsIssues };
  } catch (err) {
    log(`Could not load llms.txt (${String(err)})`);
    return { llmsTxt: null, llmsTxtUrl, llmsIssues: [] };
  }
}

function seedFromLlmsTxt(config: ResolvedConfig, frontier: Frontier, doc: LlmsTxtDoc | null): void {
  if (!doc || !config.seedFromLlmsTxt) return;
  for (const link of doc.links) frontier.add(link.url, 0, undefined, 'llms.txt');
}

async function fetchText(url: string, config: ResolvedConfig): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': config.userAgent },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// --- outcome -----------------------------------------------------------------

export function countBySeverity(issues: Issue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

/**
 * The exit code a CI job should use for this report.
 *
 * Exported because severity is a contract, not a label, and a consumer wiring the crawler
 * into their own pipeline should not have to re-derive what 'fail on warning' means.
 */
export function exitCode(report: CrawlReport, failOn: Severity | 'never'): number {
  if (failOn === 'never') return 0;
  if (failOn === 'error') return report.counts.error > 0 ? 1 : 0;
  if (failOn === 'warning') return report.counts.error + report.counts.warning > 0 ? 1 : 0;
  return 0;
}
