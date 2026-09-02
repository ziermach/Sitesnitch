import type { BuiltinCheckId, Check, CheckDeps, CheckId, Issue, PageContext } from '../types.js';
import { accessibilityCheck } from './accessibility.js';
import { consoleErrorsCheck } from './consoleErrors.js';
import { forbiddenHostsCheck } from './forbiddenHosts.js';
import { httpStatusCheck } from './httpStatus.js';
import { imagesCheck } from './images.js';
import { linksCheck } from './links.js';
import { mixedContentCheck } from './mixedContent.js';
import { seoCheck } from './seo.js';

/**
 * The builtin checks. A check is a pure function of what the crawler observed — add one
 * here and it runs on every page, appears in every report, and is switchable from the CLI,
 * with no other wiring.
 *
 * 'llms-txt' and 'cross-page' are absent on purpose: they are not per-page checks. They
 * run once over the whole crawl, from crossPage.ts.
 *
 * Consumers of the library add their own without editing this file, by passing
 * `customChecks` to the crawler — see CrawlerConfig.customChecks.
 */
export const PAGE_CHECKS: Partial<Record<BuiltinCheckId, Check>> = {
  'http-status': httpStatusCheck,
  'console-errors': consoleErrorsCheck,
  'forbidden-hosts': forbiddenHostsCheck,
  seo: seoCheck,
  links: linksCheck,
  'mixed-content': mixedContentCheck,
  images: imagesCheck,
  accessibility: accessibilityCheck,
};

/**
 * Resolves a check id to its implementation, builtin or custom.
 *
 * Custom checks are looked up second, so a builtin id cannot be silently shadowed: a
 * `customChecks` entry called 'seo' would otherwise replace the real SEO check and the
 * report would still say "seo", which is exactly the kind of quiet substitution that makes
 * a clean report untrustworthy.
 */
function resolveCheck(id: CheckId, deps: CheckDeps): Check | undefined {
  return PAGE_CHECKS[id as BuiltinCheckId] ?? deps.config.customChecks.find((c) => c.id === id)?.check;
}

export async function runPageChecks(
  ctx: PageContext,
  enabled: CheckId[],
  deps: CheckDeps,
): Promise<Issue[]> {
  const issues: Issue[] = [];

  for (const id of enabled) {
    const check = resolveCheck(id, deps);
    if (!check) continue;
    issues.push(...(await check(ctx, deps)));
  }

  return issues;
}
