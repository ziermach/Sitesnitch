import type { AxeImpact, Check, Issue } from '../types.js';

/**
 * Reports axe-core's WCAG 2.1 A/AA violations.
 *
 * The rule id is axe's impact level, not the individual axe rule — `a11y-critical`,
 * `a11y-serious`, and so on. axe ships ~100 rules, and minting a priority for each would
 * mean a taxonomy nobody maintains and an unranked rule the moment axe adds one. The rule
 * that actually failed (`color-contrast`, `aria-required-attr`, …) leads the message, so
 * the report's search box still finds it instantly.
 *
 * Impact maps to priority the way axe intends it: `critical` means the content is
 * unusable with assistive technology, `minor` means it's awkward.
 */
const IMPACT_SEVERITY: Record<AxeImpact, Issue['severity']> = {
  critical: 'error',
  serious: 'error',
  moderate: 'warning',
  minor: 'warning',
};

export const accessibilityCheck: Check = (ctx): Issue[] => {
  const issues: Issue[] = [];

  // axe was supposed to run and didn't. Same principle as domError: a check that silently
  // produced nothing is indistinguishable from a page with no problems, and that is the one
  // lie this crawler must never tell.
  if (ctx.axeError) {
    issues.push({
      check: 'accessibility',
      severity: 'error',
      rule: 'a11y-audit-failed',
      message: 'axe-core could not audit this page — its accessibility is unknown, not clean',
      pageUrl: ctx.url,
      detail: ctx.axeError,
    });
    return issues;
  }

  if (!ctx.axe) return issues;

  for (const v of ctx.axe) {
    const extra = v.nodeCount > v.nodes.length ? ` (+${v.nodeCount - v.nodes.length} more)` : '';

    issues.push({
      check: 'accessibility',
      severity: IMPACT_SEVERITY[v.impact] ?? 'warning',
      rule: `a11y-${v.impact}`,
      // axe's rule id first: it is the thing you search for, and the thing you fix.
      message: `${v.id}: ${v.help} — ${v.nodeCount} element${v.nodeCount === 1 ? '' : 's'}`,
      pageUrl: ctx.url,
      target: v.helpUrl,
      where: v.nodes[0] ?? undefined,
      detail: [
        v.nodes.join('\n') + extra,
        v.failureSummary,
        `WCAG: ${wcagOf(v.tags).join(', ') || 'n/a'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
  }

  return issues;
};

/** Pulls the human-facing WCAG criteria out of axe's tag soup ('wcag2aa', 'cat.color', …). */
function wcagOf(tags: string[]): string[] {
  return tags.filter((t) => /^wcag\d/.test(t)).map((t) => t.toUpperCase());
}
