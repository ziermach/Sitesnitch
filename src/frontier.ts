import type { ResolvedConfig } from './config.js';
import { isAllowed, type RobotsRules } from './robots.js';
import {
  dedupeKey,
  isSameSite,
  localeOf,
  matchesIgnorePattern,
  normalizeUrl,
  pathMatches,
} from './url.js';

export interface FrontierItem {
  url: string;
  depth: number;
  /**
   * Where this URL was found: the URL of the page that linked to it, or 'sitemap' /
   * 'llms.txt' for a seed.
   *
   * Without this, a report can tell you /en/products/…?addons=17&addons=1073
   * returns 500, but not which page ships that link — leaving you to grep the site for it.
   * The whole point of a crawler finding a broken URL is being able to go and fix the thing
   * that points at it.
   */
  source: string;
}

export type SkipReason =
  | 'duplicate'
  | 'off-site'
  | 'ignored'
  | 'robots'
  | 'wrong-locale'
  | 'out-of-scope-path'
  | 'too-deep'
  | 'invalid'
  | 'max-pages';

/**
 * The crawl queue. Owns every reason a URL does or doesn't get crawled, in one place,
 * so "why wasn't this page crawled?" has exactly one file to read.
 *
 * Skips are counted rather than silently dropped — a run that quietly ignored 400 URLs
 * because of a robots rule should say so.
 */
export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();
  private readonly skips = new Map<SkipReason, number>();
  private accepted = 0;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly robots: RobotsRules,
  ) {}

  /**
   * Offers a URL to the queue. Returns the reason it was rejected, or null if accepted.
   * `base` resolves relative hrefs found in page HTML.
   */
  add(rawUrl: string, depth: number, base?: string, source?: string): SkipReason | null {
    const url = normalizeUrl(rawUrl, base);
    if (!url) return this.skip('invalid');

    // Identity is slash-insensitive (`/en/vps` and `/en/vps/` are one page), but we queue
    // and fetch the URL exactly as it was authored.
    const key = dedupeKey(url);
    if (!key) return this.skip('invalid');
    if (this.seen.has(key)) return this.skip('duplicate');

    if (depth > this.config.maxDepth) {
      // Don't mark seen — a shallower path to this page may show up later and should win.
      return this.skip('too-deep');
    }
    if (!isSameSite(url, this.config.baseUrl)) return this.skipAndSeen(key, 'off-site');
    if (matchesIgnorePattern(url, this.config.ignorePatterns)) return this.skipAndSeen(key, 'ignored');
    if (this.config.respectRobots && !isAllowed(url, this.robots)) {
      return this.skipAndSeen(key, 'robots');
    }
    if (!this.inScopeLocale(url)) return this.skipAndSeen(key, 'wrong-locale');
    if (!this.inScopePath(url)) return this.skipAndSeen(key, 'out-of-scope-path');
    if (this.accepted >= this.config.maxPages) return this.skip('max-pages');

    this.seen.add(key);
    this.accepted++;
    this.queue.push({ url, depth, source: source ?? base ?? 'seed' });
    return null;
  }

  /**
   * A URL is in scope if it carries one of the configured locale prefixes, or no locale
   * prefix at all (the root, `/blog/...`, and other locale-agnostic paths).
   */
  private inScopeLocale(url: string): boolean {
    if (this.config.locales.length === 0) return true;
    const locale = localeOf(url, ALL_KNOWN_LOCALES);
    if (locale === null) return true;
    return this.config.locales.includes(locale);
  }

  /**
   * Path scoping. `includePaths` is an allow-list and wins outright — that is how a run gets
   * scoped to a single project (`--paths /blog`). Otherwise `excludePaths` carves things out.
   */
  private inScopePath(url: string): boolean {
    if (this.config.includePaths.length > 0) {
      return pathMatches(url, this.config.includePaths, ALL_KNOWN_LOCALES);
    }
    if (this.config.excludePaths.length > 0) {
      return !pathMatches(url, this.config.excludePaths, ALL_KNOWN_LOCALES);
    }
    return true;
  }

  next(): FrontierItem | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.queue.length;
  }

  get acceptedCount(): number {
    return this.accepted;
  }

  get skipCounts(): Record<string, number> {
    return Object.fromEntries(this.skips);
  }

  private skip(reason: SkipReason): SkipReason {
    this.skips.set(reason, (this.skips.get(reason) ?? 0) + 1);
    return reason;
  }

  private skipAndSeen(key: string, reason: SkipReason): SkipReason {
    this.seen.add(key);
    return this.skip(reason);
  }
}

/**
 * Every locale prefix the site *can* serve — not the ones we're crawling.
 *
 * The distinction matters: to reject `/de/vps` when crawling only `en`, we must first
 * recognize `de` as a locale segment. Using the configured locale list for that would
 * make `/de/vps` look like a locale-less path and crawl it anyway.
 */
const ALL_KNOWN_LOCALES = ['en', 'es', 'de', 'en-us'];
