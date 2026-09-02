import type { Check, Issue } from '../types.js';

/** The page's own health: did it load, what did it return, and how did it get there. */
export const httpStatusCheck: Check = (ctx, { config }): Issue[] => {
  const issues: Issue[] = [];

  /**
   * Every page-level finding carries where the URL was found.
   *
   * "…/widget-24-pack/?addons=17&addons=1073 returns 500" is only half a bug report:
   * the URL is the symptom, and the page shipping that href is the thing to fix. Without
   * this you are left grepping the site for a query string.
   */
  const foundOn = ctx.source && ctx.source !== 'seed' ? `found on: ${ctx.source}` : undefined;
  const withSource = (detail?: string): string | undefined =>
    [detail, foundOn].filter(Boolean).join('\n') || undefined;

  if (ctx.navigationError) {
    issues.push({
      check: 'http-status',
      severity: 'error',
      rule: 'navigation-failed',
      message: `Page failed to load: ${ctx.navigationError}`,
      pageUrl: ctx.url,
      detail: withSource(`after ${ctx.loadMs}ms`),
    });
    return issues;
  }

  // The page loaded but we failed to read it, so seo/links/images/mixed-content and the
  // DOM surfaces of forbidden-hosts all reported nothing for this page. Without this
  // issue, that reads as "clean" — the exact lie this crawler exists to prevent.
  if (ctx.domError) {
    issues.push({
      check: 'http-status',
      severity: 'error',
      rule: 'dom-extraction-failed',
      message: 'Could not read the page DOM — every content check was skipped for this page',
      pageUrl: ctx.url,
      detail: withSource(ctx.domError),
    });
  }

  if (ctx.status >= 500) {
    issues.push({
      check: 'http-status',
      severity: 'error',
      rule: 'server-error',
      message: `Page returned ${ctx.status}`,
      pageUrl: ctx.url,
      detail: withSource(`final URL: ${ctx.finalUrl}`),
    });
  } else if (ctx.status >= 400) {
    issues.push({
      check: 'http-status',
      severity: 'error',
      rule: 'client-error',
      message: `Page returned ${ctx.status}`,
      pageUrl: ctx.url,
      detail: withSource(`final URL: ${ctx.finalUrl}`),
    });
  }

  if (ctx.redirectChain.length > config.maxRedirectHops) {
    issues.push({
      check: 'http-status',
      severity: 'warning',
      rule: 'long-redirect-chain',
      message: `${ctx.redirectChain.length} redirect hops before reaching the page`,
      pageUrl: ctx.url,
      where: 'redirect-chain',
      detail: withSource([...ctx.redirectChain, ctx.finalUrl].join(' -> ')),
    });
  }

  // A redirect that lands on an error is a special kind of nasty: the source URL looks
  // "handled" (someone wrote the redirect rule) but the destination is gone.
  if (ctx.redirectChain.length > 0 && ctx.status >= 400) {
    issues.push({
      check: 'http-status',
      severity: 'error',
      rule: 'redirect-to-error',
      message: `Redirect chain ends in ${ctx.status}`,
      pageUrl: ctx.url,
      where: 'redirect-chain',
      detail: withSource([...ctx.redirectChain, ctx.finalUrl].join(' -> ')),
    });
  }

  return issues;
};
