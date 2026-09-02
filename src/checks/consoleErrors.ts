import type { Check, Issue } from '../types.js';
import { urlBelongsTo } from '../url.js';

/**
 * Failures we can neither fix nor act on: a blocked tracker, a consent layer refusing to
 * load an ad pixel. Downgraded to info rather than dropped — still visible if you go
 * looking, but it won't fail a build or bury a real exception.
 */
const NOISE_PATTERNS = [
  /ERR_BLOCKED_BY_CLIENT/i,
  /Content Security Policy.*(analytics|tag|pixel)/i,
];

export const consoleErrorsCheck: Check = (ctx, { config }): Issue[] => {
  const issues: Issue[] = [];
  const seen = new Set<string>();

  // Console text is prose, not a URL, so a tracking host is matched as a substring —
  // an exception thrown from inside a GTM bundle names it somewhere in the message or stack.
  const isNoise = (text: string): boolean =>
    NOISE_PATTERNS.some((re) => re.test(text)) ||
    config.trackingHosts.some((host) => text.toLowerCase().includes(host.toLowerCase()));

  for (const entry of ctx.console) {
    // The same error fires once per component instance on some pages. Dedupe by text.
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);

    if (entry.type === 'warning') {
      issues.push({
        check: 'console-errors',
        severity: 'info',
        rule: 'console-warning',
        message: `console.warn: ${truncate(entry.text, 200)}`,
        pageUrl: ctx.url,
        where: entry.location,
      });
      continue;
    }

    const noise = isNoise(entry.text);
    issues.push({
      check: 'console-errors',
      severity: noise ? 'info' : 'error',
      rule: entry.type === 'pageerror' ? 'uncaught-exception' : 'console-error',
      message:
        entry.type === 'pageerror'
          ? `Uncaught exception: ${truncate(entry.text, 200)}`
          : `console.error: ${truncate(entry.text, 200)}`,
      pageUrl: ctx.url,
      where: entry.location,
      detail: noise ? 'third-party script — downgraded to info' : undefined,
    });
  }

  for (const req of ctx.failedRequests) {
    const key = `${req.status}:${req.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const noise =
      urlBelongsTo(req.url, config.trackingHosts) || isNoise(req.url) || isNoise(req.failure ?? '');
    const description =
      req.status > 0 ? `returned ${req.status}` : `failed (${req.failure ?? 'unknown'})`;

    issues.push({
      check: 'console-errors',
      severity: noise ? 'info' : 'error',
      rule: req.status > 0 ? 'subresource-error-status' : 'subresource-request-failed',
      message: `${req.resourceType} ${description}`,
      pageUrl: ctx.url,
      target: req.url,
      where: 'network',
      detail: noise ? 'third-party resource — downgraded to info' : req.method,
    });
  }

  if (ctx.dom?.consentBannerVisible) {
    // Loud on purpose. If the banner is up, the page under it may not have executed its
    // scripts, and every other check on this page is measuring the overlay, not the site.
    issues.push({
      check: 'console-errors',
      severity: 'warning',
      rule: 'consent-banner-not-dismissed',
      message: 'Cookie-consent overlay still visible after load — results for this page may be unreliable',
      pageUrl: ctx.url,
    });
  }

  return issues;
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
