import { describe, expect, it } from 'vitest';
import { blockedIssue, detectBlock } from '../src/blocked.js';
import { httpStatusCheck } from '../src/checks/httpStatus.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { classify } from '../src/classify.js';
import type { CheckDeps, DomSnapshot, Issue, PageContext } from '../src/types.js';

function dom(title: string): DomSnapshot {
  return {
    title,
    metaDescription: null,
    metaRobots: 'noindex,nofollow',
    canonical: null,
    htmlLang: 'en-US',
    h1s: [],
    og: {},
    hreflang: [],
    links: [],
    images: [],
    resources: [],
    inlineScripts: [],
    consentBannerVisible: false,
  };
}

function page(over: Partial<PageContext> = {}): PageContext {
  return {
    url: 'https://example.com/pl',
    finalUrl: 'https://example.com/pl',
    status: 200,
    redirectChain: [],
    depth: 0,
    source: 'sitemap',
    loadMs: 100,
    dom: dom('A real page'),
    console: [],
    failedRequests: [],
    requestUrls: [],
    axe: null,
    ...over,
  };
}

const deps: CheckDeps = { config: DEFAULT_CONFIG, linkStatus: () => undefined };

/** The check is synchronous; the shared Check signature allows async, hence the narrowing. */
const run = (ctx: PageContext): Issue[] => httpStatusCheck(ctx, deps) as Issue[];

/**
 * The finding that prompted all of this: a page behind Cloudflare came back as a P1
 * `client-error` and a P0 `redirect-to-error` (the challenge reloads the same URL, so the
 * chain reads `/pl -> /pl`), when in fact a human opens that page perfectly well. 485 pages
 * in one run looked broken and were not.
 */
describe('pages the site refused to serve us', () => {
  it('does not call a Cloudflare challenge a broken page', () => {
    const issues = run(
      page({
        status: 403,
        redirectChain: ['https://example.com/pl'],
        dom: dom('Just a moment...'),
      }),
    );

    const rules = issues.map((i) => i.rule);
    expect(rules).toEqual(['page-blocked']);
    expect(rules).not.toContain('client-error');
    expect(rules).not.toContain('redirect-to-error');
  });

  it('reports a rate limit whatever the body says', () => {
    // Sites often answer 429 with a maintenance-style page of their own wording rather
    // than a recognisable challenge. The status is the evidence; the title list is not.
    const issues = run(page({ status: 429, dom: dom('Please try again shortly') }));

    expect(issues.map((i) => i.rule)).toEqual(['page-blocked']);
    expect(issues[0]?.detail).toContain('Please try again shortly');
  });

  it('never fails a build over a refusal, but never hides one either', () => {
    const [issue] = run(page({ status: 429, dom: dom('Just a moment...') }));

    // A refused page is not a broken page: severity error would fail --fail-on=error.
    expect(issue?.severity).toBe('warning');
    // But it is a hole in the coverage, and holes are triaged, not swallowed.
    expect(classify('page-blocked').category).toBe('coverage');
    expect(classify('page-blocked').priority).toBe('P1');
  });

  it('still calls a plain 403 a client error', () => {
    // The dangerous over-correction. A sitemap-listed URL that refuses the public is a real
    // defect; downgrading every 403 to shed some Cloudflare noise would trade a false
    // positive for a false negative, which is the worse of the two.
    const issues = run(page({ status: 403, dom: dom('Members only') }));

    expect(issues.map((i) => i.rule)).toEqual(['client-error']);
  });

  it('leaves 404s and 5xx exactly as they were', () => {
    expect(run(page({ status: 404 })).map((i) => i.rule)).toEqual(['client-error']);
    expect(run(page({ status: 503 })).map((i) => i.rule)).toEqual(['server-error']);
  });

  it('does not mistake a healthy page for a blocked one', () => {
    expect(detectBlock(page())).toBeNull();
    expect(detectBlock(page({ status: 200, dom: dom('Just a moment...') }))).toBeNull();
  });

  it('says how many attempts it took before giving up', () => {
    const issue = blockedIssue(
      { url: 'https://example.com/pl', status: 429, source: 'sitemap', attempts: 3 },
      { kind: 'rate-limited', evidence: 'HTTP 429' },
    );

    expect(issue.detail).toContain('still blocked after 3 attempts');
    expect(issue.detail).toContain('found on: sitemap');
  });
});
