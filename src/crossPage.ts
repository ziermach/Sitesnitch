import type { ResolvedConfig } from './config.js';
import type { LinkChecker } from './linkChecker.js';
import type { LlmsTxtDoc } from './llmsTxt.js';
import type { Issue, PageResult } from './types.js';
import { dedupeKey } from './url.js';

export interface CrossPageInput {
  pages: PageResult[];
  sitemapUrls: string[];
  llmsTxt: LlmsTxtDoc | null;
  llmsTxtUrl: string;
  linkChecker: LinkChecker;
  config: ResolvedConfig;
}

/**
 * Findings that only exist when you look at the whole crawl at once.
 *
 * Nothing here is visible from a single page: a duplicate title needs two pages to
 * compare, hreflang reciprocity needs the page on the other end, and llms.txt drift
 * needs to know what the crawl actually found.
 */
export function runCrossPageChecks(input: CrossPageInput): Issue[] {
  const { pages, sitemapUrls, llmsTxt, llmsTxtUrl, linkChecker, config } = input;
  const issues: Issue[] = [];

  const ok = pages.filter((p) => p.context.status >= 200 && p.context.status < 300);

  issues.push(...duplicateMeta(ok));
  issues.push(...hreflangReciprocity(ok));
  issues.push(...sitemapDrift(ok, sitemapUrls, config));
  if (llmsTxt) issues.push(...llmsTxtDrift(llmsTxt, llmsTxtUrl, ok, sitemapUrls, linkChecker));

  return issues;
}

/**
 * Two pages sharing a title or description are competing with each other in search
 * results, and it usually means a template is not filling in a variable.
 */
function duplicateMeta(pages: PageResult[]): Issue[] {
  const issues: Issue[] = [];

  const group = (key: (p: PageResult) => string | null | undefined): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const page of pages) {
      const value = key(page);
      if (!value) continue;
      const urls = map.get(value) ?? [];
      urls.push(page.context.url);
      map.set(value, urls);
    }
    return map;
  };

  for (const [title, urls] of group((p) => p.context.dom?.title)) {
    if (urls.length < 2) continue;
    issues.push({
      check: 'cross-page',
      severity: 'warning',
      rule: 'duplicate-title',
      message: `${urls.length} pages share the title "${truncate(title, 80)}"`,
      pageUrl: urls[0]!,
      detail: urls.join('\n'),
    });
  }

  for (const [description, urls] of group((p) => p.context.dom?.metaDescription)) {
    if (urls.length < 2) continue;
    issues.push({
      check: 'cross-page',
      severity: 'warning',
      rule: 'duplicate-meta-description',
      message: `${urls.length} pages share the same meta description`,
      pageUrl: urls[0]!,
      detail: `"${truncate(description, 100)}"\n${urls.join('\n')}`,
    });
  }

  return issues;
}

/**
 * hreflang is only honoured when it's mutual. If /en/vps declares /de/vps as its German
 * alternate but /de/vps doesn't point back, search engines discard the whole cluster —
 * and the markup looks completely correct while doing nothing.
 */
function hreflangReciprocity(pages: PageResult[]): Issue[] {
  const issues: Issue[] = [];

  const byUrl = new Map<string, PageResult>();
  for (const page of pages) {
    const url = dedupeKey(page.context.finalUrl);
    if (url) byUrl.set(url, page);
  }

  for (const page of pages) {
    const alternates = page.context.dom?.hreflang ?? [];
    const selfUrl = dedupeKey(page.context.finalUrl);
    if (!selfUrl) continue;

    for (const alt of alternates) {
      const altUrl = dedupeKey(alt.href);
      if (!altUrl || altUrl === selfUrl) continue;

      // Only assert reciprocity for pages we actually crawled. An alternate we never
      // visited might well point back; we just don't know, and guessing would be noise.
      const target = byUrl.get(altUrl);
      if (!target) continue;

      const pointsBack = (target.context.dom?.hreflang ?? []).some(
        (a) => dedupeKey(a.href) === selfUrl,
      );
      if (!pointsBack) {
        issues.push({
          check: 'cross-page',
          severity: 'warning',
          rule: 'hreflang-not-reciprocal',
          message: `Declares hreflang="${alt.hreflang}" alternate that does not point back`,
          pageUrl: page.context.url,
          target: altUrl,
          where: `link[hreflang=${alt.hreflang}]`,
        });
      }
    }
  }

  return issues;
}

/** Pages in the sitemap nothing links to, and crawled pages the sitemap forgot. */
function sitemapDrift(
  pages: PageResult[],
  sitemapUrls: string[],
  config: ResolvedConfig,
): Issue[] {
  if (sitemapUrls.length === 0) return [];

  const issues: Issue[] = [];
  const crawled = new Set(pages.map((p) => dedupeKey(p.context.finalUrl)).filter(Boolean));
  const inSitemap = new Set(sitemapUrls.map((u) => dedupeKey(u)).filter(Boolean));

  const missingFromSitemap = [...crawled].filter((u) => u && !inSitemap.has(u));
  if (missingFromSitemap.length > 0) {
    issues.push({
      check: 'cross-page',
      severity: 'warning',
      rule: 'page-missing-from-sitemap',
      message: `${missingFromSitemap.length} crawled pages are not listed in the sitemap`,
      pageUrl: config.baseUrl,
      detail: missingFromSitemap.slice(0, 50).join('\n'),
    });
  }

  return issues;
}

/**
 * llms.txt is hand-maintained, so unlike the generated sitemap it rots. A dead link in it
 * is served as fact to every AI agent that reads the file, which is why the status
 * failures below are errors rather than warnings.
 */
function llmsTxtDrift(
  doc: LlmsTxtDoc,
  llmsTxtUrl: string,
  pages: PageResult[],
  sitemapUrls: string[],
  linkChecker: LinkChecker,
): Issue[] {
  const issues: Issue[] = [];

  for (const link of doc.links) {
    const status = linkChecker.get(link.url);
    if (!status) continue;

    const label = link.title ? `"${truncate(link.title, 60)}"` : link.url;
    const where = link.section ? `llms.txt section "${link.section}", line ${link.line}` : `llms.txt line ${link.line}`;

    if (status.status === 0) {
      issues.push({
        check: 'llms-txt',
        severity: 'error',
        rule: 'llms-txt-link-unreachable',
        message: `llms.txt link ${label} is unreachable: ${status.error ?? 'request failed'}`,
        pageUrl: llmsTxtUrl,
        target: link.url,
        where,
      });
    } else if (status.status >= 400) {
      issues.push({
        check: 'llms-txt',
        severity: 'error',
        rule: 'llms-txt-link-dead',
        message: `llms.txt link ${label} returned ${status.status}`,
        pageUrl: llmsTxtUrl,
        target: link.url,
        where,
      });
    } else if (status.redirects > 0) {
      issues.push({
        check: 'llms-txt',
        severity: 'warning',
        rule: 'llms-txt-link-redirects',
        message: `llms.txt link ${label} redirects — update it to the final URL`,
        pageUrl: llmsTxtUrl,
        target: link.url,
        where,
        detail: `-> ${status.finalUrl ?? '(unknown)'}`,
      });
    }
  }

  // Drift the other way: pages the site publishes in its sitemap but llms.txt never
  // mentions. Reported as one aggregate warning — this is a content decision, not a bug,
  // and a per-URL issue for each would swamp the report.
  const listed = new Set(doc.links.map((l) => dedupeKey(l.url)).filter(Boolean) as string[]);
  const sitemapSet = new Set(sitemapUrls.map((u) => dedupeKey(u)).filter(Boolean) as string[]);
  const notListed = [...sitemapSet].filter((u) => !listed.has(u));

  if (sitemapSet.size > 0 && notListed.length > 0) {
    issues.push({
      check: 'llms-txt',
      severity: 'info',
      rule: 'llms-txt-coverage',
      message: `llms.txt lists ${listed.size} URLs; ${notListed.length} sitemap URLs are not in it`,
      pageUrl: llmsTxtUrl,
      detail: notListed.slice(0, 50).join('\n'),
    });
  }

  return issues;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
