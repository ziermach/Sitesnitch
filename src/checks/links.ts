import type { Check, Issue } from '../types.js';
import { matchesIgnorePattern, normalizeUrl, urlBelongsTo } from '../url.js';

/**
 * Statuses that mean "the server refused *us*" rather than "this link is broken".
 *
 * Facebook answers an automated HEAD with 400, LinkedIn with 999, plenty of WAFs with 403.
 * Filing those as dead links puts a fake error next to every social icon in the footer,
 * on every page — and a report with obvious false positives in it stops being read.
 * A human clicking the link would land on a perfectly good page.
 */
const REFUSAL_STATUSES = new Set([400, 401, 403, 405, 429, 999]);

/**
 * Reports the status of every link on the page.
 *
 * The probing itself happened earlier, in LinkChecker — by the time this runs, statuses
 * are in cache. That split is deliberate: probing is IO-bound and shared across pages,
 * while this is pure and per-page.
 */
export const linksCheck: Check = (ctx, { config, linkStatus }): Issue[] => {
  const issues: Issue[] = [];
  if (!ctx.dom) return issues;

  const seen = new Set<string>();

  for (const link of ctx.dom.links) {
    const url = normalizeUrl(link.href);
    if (!url) continue;
    if (matchesIgnorePattern(url, config.ignorePatterns)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const status = linkStatus(url);
    if (!status) continue;

    const label = link.text ? `"${truncate(link.text, 60)}"` : '(no text)';

    if (status.status === 0) {
      issues.push({
        check: 'links',
        severity: 'error',
        rule: 'link-unreachable',
        message: `Link ${label} is unreachable: ${status.error ?? 'request failed'}`,
        pageUrl: ctx.url,
        target: url,
        where: 'a[href]',
      });
      // Refusals are tested BEFORE the 5xx branch on purpose. LinkedIn answers bots with
      // 999, which is >= 500 and would otherwise be filed as a server error — the refusal
      // handling below would simply never be reached for the one host that needs it most.
    } else if (REFUSAL_STATUSES.has(status.status)) {
      // Refused, not broken. A warning so it stays visible, but it won't fail a build and
      // it won't sit in the errors list pretending the footer is broken.
      const known = urlBelongsTo(url, config.botHostileHosts);
      issues.push({
        check: 'links',
        severity: known ? 'info' : 'warning',
        rule: 'link-refused',
        message: `Link ${label} returned ${status.status} to an automated request`,
        pageUrl: ctx.url,
        target: url,
        where: 'a[href]',
        detail: known
          ? 'host is known to block bots — a human visitor is likely fine'
          : 'may be anti-bot protection rather than a broken link; verify by hand',
      });
    } else if (status.status >= 500) {
      issues.push({
        check: 'links',
        severity: 'error',
        rule: 'link-server-error',
        message: `Link ${label} returned ${status.status}`,
        pageUrl: ctx.url,
        target: url,
        where: 'a[href]',
      });
    } else if (status.status >= 400) {
      issues.push({
        check: 'links',
        severity: 'error',
        rule: 'link-dead',
        message: `Link ${label} returned ${status.status}`,
        pageUrl: ctx.url,
        target: url,
        where: 'a[href]',
      });
    } else if (status.redirects > 0) {
      issues.push({
        check: 'links',
        severity: 'warning',
        rule: 'link-redirects',
        message: `Link ${label} redirects`,
        pageUrl: ctx.url,
        target: url,
        where: 'a[href]',
        detail: `-> ${status.finalUrl ?? '(unknown)'}`,
      });
    }

    if (status.status !== 0 && status.durationMs > config.slowLinkMs) {
      issues.push({
        check: 'links',
        severity: 'warning',
        rule: 'link-slow',
        message: `Link ${label} took ${status.durationMs}ms to respond`,
        pageUrl: ctx.url,
        target: url,
        where: 'a[href]',
      });
    }
  }

  return issues;
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
