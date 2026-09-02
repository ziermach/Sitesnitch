import type { Issue, PageContext } from './types.js';

/**
 * "The site refused *us*" is a different finding from "the site is broken", and conflating
 * the two is how a report loses its readers.
 *
 * `links.ts` has known this since Facebook started answering our HEAD probes with 400: a
 * 403 from a WAF says something about the crawler, not about the URL. The page-level checks
 * never learned the same lesson, and one run made the cost concrete — 485 pages
 * behind Cloudflare came back as 485 P1 `client-error`s and 9 P0 `redirect-to-error`s, all
 * of which a human visitor loads perfectly well.
 *
 * A blocked page is not clean either, though. We measured Cloudflare's interstitial, not the
 * site: no links to follow, no DOM to check, axe blocked by the challenge's CSP. That is a
 * hole in the crawl's coverage — the same class of finding as `dom-extraction-failed` — and
 * it must be reported as one rather than dressed up as a broken page or hidden entirely.
 */
export type BlockKind = 'rate-limited' | 'bot-challenge';

export interface BlockVerdict {
  kind: BlockKind;
  /** What we actually saw, for the report — never just the rule's own say-so. */
  evidence: string;
}

/**
 * Titles served by bot-protection interstitials rather than by the site.
 *
 * Deliberately generic (Cloudflare and the common WAFs), not per-site. A site's own
 * rate-limit page, in whatever wording it chooses, needs no entry here: it comes
 * with a 429, which is self-describing.
 */
const CHALLENGE_TITLES = [
  'just a moment',
  'attention required',
  'checking your browser',
  'access denied',
  'verify you are human',
  'verifying you are human',
  'security check',
];

/** 429 means it unambiguously, whatever the body says. */
export function isRateLimited(status: number): boolean {
  return status === 429;
}

/**
 * Decides whether what we fetched was the site or its doorman.
 *
 * Narrow on purpose. A 403 with a real page behind it stays a `client-error`: a
 * sitemap-listed URL that refuses the public is a genuine defect, and swallowing it here to
 * be rid of some Cloudflare noise would trade a false positive for a false negative — much
 * the worse of the two. Only a recognisable challenge body downgrades a 403.
 */
export function detectBlock(ctx: Pick<PageContext, 'status' | 'dom'>): BlockVerdict | null {
  const title = ctx.dom?.title?.trim() ?? '';
  const challenge = CHALLENGE_TITLES.find((t) => title.toLowerCase().startsWith(t));

  if (isRateLimited(ctx.status)) {
    return {
      kind: 'rate-limited',
      evidence: title
        ? `HTTP 429, page titled "${title}"`
        : 'HTTP 429',
    };
  }

  // 503 is Cloudflare's older "under attack" response. A 503 with no challenge body is a
  // real outage and belongs in server-error, where it already is.
  if ((ctx.status === 403 || ctx.status === 503) && challenge) {
    return {
      kind: 'bot-challenge',
      evidence: `HTTP ${ctx.status}, bot-protection interstitial titled "${title}"`,
    };
  }

  return null;
}

/**
 * The one issue a blocked page gets. Severity `warning`, never `error`: the site is not
 * broken, so this must not fail a build — but the page went unmeasured, so it must not be
 * silent either.
 */
export function blockedIssue(
  ctx: Pick<PageContext, 'url' | 'status' | 'source' | 'attempts'>,
  verdict: BlockVerdict,
): Issue {
  const attempts = ctx.attempts ?? 1;
  const detail = [
    verdict.evidence,
    attempts > 1 ? `still blocked after ${attempts} attempts` : undefined,
    verdict.kind === 'rate-limited'
      ? 'we were asked to slow down — lower concurrency for this site, then re-run'
      : 'anti-bot protection, not a site defect — but nothing on this page was checked',
    ctx.source && ctx.source !== 'seed' ? `found on: ${ctx.source}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    check: 'http-status',
    severity: 'warning',
    rule: 'page-blocked',
    message:
      verdict.kind === 'rate-limited'
        ? `Blocked by rate limiting (${ctx.status}) — page not checked`
        : `Blocked by bot protection (${ctx.status}) — page not checked`,
    pageUrl: ctx.url,
    detail,
  };
}
