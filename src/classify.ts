import type { Issue } from './types.js';

/**
 * Priority answers "when does this get fixed?", which is a different question from
 * severity ("how sure are we it's wrong?").
 *
 * A missing alt attribute is a certain defect (severity: error-adjacent) that nobody needs
 * to fix today. A staging link on the German pricing page is both certain AND urgent. The
 * report needs both axes or it can't be triaged: sorting 10,000 issues by severity alone
 * puts 670 missing <h1>s ahead of your privacy policy pointing at staging.
 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: 'Critical — fix now',
  P1: 'High — fix this sprint',
  P2: 'Medium — schedule it',
  P3: 'Low — cleanup',
};

export type Category =
  | 'environment-leak'
  | 'availability'
  | 'javascript'
  | 'security'
  | 'accessibility'
  | 'seo'
  | 'media'
  | 'content'
  | 'coverage';

export const CATEGORY_LABEL: Record<Category, string> = {
  'environment-leak': 'Staging / Dev leak',
  availability: 'Broken pages & links',
  javascript: 'JavaScript errors',
  security: 'Security',
  accessibility: 'Accessibility (WCAG)',
  seo: 'SEO',
  media: 'Images & media',
  content: 'Content quality',
  coverage: 'Crawl coverage',
};

export interface RuleMeta {
  priority: Priority;
  category: Category;
  /** Why it sits at this priority. Shown in the report so the ranking can be argued with. */
  rationale: string;
}

/**
 * Every rule the crawler can emit, ranked. Unclassified rules are a test failure — an
 * unranked issue silently sorts to the bottom of the report and is never seen.
 */
export const RULE_META: Record<string, RuleMeta> = {
  // ---- P0: production is actively lying to or losing customers -----------------------
  'forbidden-host-in-link': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'A customer clicking this link lands on a staging environment.',
  },
  'forbidden-host-in-resource': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'Production is loading an asset from a non-production host.',
  },
  'forbidden-host-in-request': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'Live JavaScript is calling a non-production endpoint at runtime.',
  },
  'forbidden-host-in-canonical': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'Search engines are being told the staging URL is the canonical one.',
  },
  'forbidden-host-in-redirect': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'A production URL routes through a non-production host.',
  },
  'forbidden-host-in-hreflang': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'A staging URL is published as the alternate for another locale.',
  },
  'forbidden-host-in-og': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'Shared/social previews point at a staging host.',
  },
  'forbidden-host-in-inline-script': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'A staging endpoint is shipped in page config — reachable whether or not it is called yet.',
  },
  'forbidden-host-in-text-file': {
    priority: 'P0',
    category: 'environment-leak',
    rationale: 'A staging URL is served in a machine-read file (llms.txt / robots.txt).',
  },
  'server-error': {
    priority: 'P0',
    category: 'availability',
    rationale: 'The page is 5xx: visitors get nothing at all.',
  },
  'redirect-to-error': {
    priority: 'P0',
    category: 'availability',
    rationale: 'Someone wrote a redirect rule and the destination is gone — looks handled, is not.',
  },
  'navigation-failed': {
    priority: 'P0',
    category: 'availability',
    rationale: 'The page could not be loaded at all.',
  },
  'dom-extraction-failed': {
    priority: 'P0',
    category: 'coverage',
    rationale: 'We could not read this page, so every content check silently skipped it. A hole in the crawl, not a clean page.',
  },

  // ---- Accessibility (axe-core, WCAG 2.1 A/AA) ---------------------------------------
  //
  // Ranked by axe's own impact scale, which is a statement about the user, not the code:
  // `critical` means someone using a screen reader or keyboard cannot complete the task at
  // all. That is a broken page for that person, so it sits alongside the other P1 breakage
  // rather than in a "nice to have" tier. It is also, under the European Accessibility Act,
  // a legal exposure and not merely a quality one.
  'a11y-critical': {
    priority: 'P1',
    category: 'accessibility',
    rationale: 'Blocks assistive-technology users outright — the content is unusable, not just awkward.',
  },
  'a11y-serious': {
    priority: 'P1',
    category: 'accessibility',
    rationale: 'Severe barrier: users can get through only with real difficulty, if at all.',
  },
  'a11y-moderate': {
    priority: 'P2',
    category: 'accessibility',
    rationale: 'Real friction for assistive-technology users, but the task remains possible.',
  },
  'a11y-minor': {
    priority: 'P3',
    category: 'accessibility',
    rationale: 'Annoyance rather than barrier.',
  },
  'a11y-audit-failed': {
    priority: 'P1',
    category: 'coverage',
    rationale: 'axe could not run, so this page’s accessibility is unknown — which is not the same as clean.',
  },

  // ---- P1: broken for real users, or invisible to search -----------------------------
  'client-error': {
    priority: 'P1',
    category: 'availability',
    rationale: 'The page 404s. Linked or indexed, and gone.',
  },
  'link-dead': {
    priority: 'P1',
    category: 'availability',
    rationale: 'A link on a live page leads to a 404.',
  },
  'link-server-error': {
    priority: 'P1',
    category: 'availability',
    rationale: 'A link on a live page leads to a 5xx.',
  },
  'link-unreachable': {
    priority: 'P1',
    category: 'availability',
    rationale: 'The target does not resolve — often a malformed URL shipped in the markup.',
  },
  'llms-txt-link-dead': {
    priority: 'P1',
    category: 'availability',
    rationale: 'A dead entry in llms.txt is a wrong answer served to every AI agent that reads it.',
  },
  'llms-txt-link-unreachable': {
    priority: 'P1',
    category: 'availability',
    rationale: 'An unreachable entry in llms.txt is served as fact to every AI agent that reads it.',
  },
  'uncaught-exception': {
    priority: 'P1',
    category: 'javascript',
    rationale: 'JavaScript is throwing in real visitors’ browsers; whatever it powers is broken.',
  },
  'console-error': {
    priority: 'P1',
    category: 'javascript',
    rationale: 'The site’s own code is reporting an error condition on a live page.',
  },
  'subresource-request-failed': {
    priority: 'P1',
    category: 'javascript',
    rationale: 'A script, stylesheet or asset the page asked for never arrived.',
  },
  'subresource-error-status': {
    priority: 'P1',
    category: 'javascript',
    rationale: 'A resource the page depends on returned an error status.',
  },
  'insecure-subresource': {
    priority: 'P1',
    category: 'security',
    rationale: 'http:// resource on an https:// page — browsers block it, so it silently does not load.',
  },
  'noindex-on-live-page': {
    priority: 'P1',
    category: 'seo',
    rationale: 'The page is deliberately hidden from search. Perfect-looking, and simply not there.',
  },
  'canonical-off-site': {
    priority: 'P1',
    category: 'seo',
    rationale: 'Search engines are told another site owns this content.',
  },
  'invalid-canonical': {
    priority: 'P1',
    category: 'seo',
    rationale: 'The canonical tag is not a usable URL, so it is ignored.',
  },

  // ---- P2: wrong, but nobody is losing a sale today ----------------------------------
  'missing-title': {
    priority: 'P2',
    category: 'seo',
    rationale: 'No <title>: search results and browser tabs have nothing to show.',
  },
  'missing-h1': {
    priority: 'P2',
    category: 'seo',
    rationale: 'No <h1>: the page never states what it is about.',
  },
  'multiple-h1': {
    priority: 'P2',
    category: 'seo',
    rationale: 'Competing <h1>s muddy what the page is about.',
  },
  'broken-image': {
    priority: 'P2',
    category: 'media',
    rationale: 'A visible image fails to render for every visitor.',
  },
  'missing-canonical': {
    priority: 'P2',
    category: 'seo',
    rationale: 'Without a canonical, duplicate URLs compete with each other.',
  },
  'long-redirect-chain': {
    priority: 'P2',
    category: 'availability',
    rationale: 'Every hop costs latency and leaks link equity.',
  },
  'link-refused': {
    priority: 'P2',
    category: 'availability',
    rationale: 'The host refused an automated request. Often anti-bot, not a broken link — verify by hand.',
  },
  'llms-txt-link-redirects': {
    priority: 'P2',
    category: 'content',
    rationale: 'llms.txt should name the final URL, not one that bounces.',
  },
  'consent-banner-not-dismissed': {
    priority: 'P2',
    category: 'coverage',
    rationale: 'A consent overlay may have masked this page — results for it are suspect.',
  },
  'consent-banner-missing': {
    priority: 'P1',
    category: 'security',
    rationale: 'No consent banner shown to a first-time visitor — a compliance exposure, not just cosmetic.',
  },
  'consent-banner-check-failed': {
    priority: 'P2',
    category: 'coverage',
    rationale: 'Could not verify the banner at all, so its presence for real visitors is unknown.',
  },
  'duplicate-title': {
    priority: 'P2',
    category: 'content',
    rationale: 'Pages sharing a title compete in search; usually a template not filling a variable.',
  },
  'duplicate-meta-description': {
    priority: 'P2',
    category: 'content',
    rationale: 'Pages sharing a description compete in search.',
  },
  'hreflang-missing-self': {
    priority: 'P2',
    category: 'seo',
    rationale: 'An hreflang cluster without a self-reference is discarded wholesale.',
  },
  'hreflang-not-reciprocal': {
    priority: 'P2',
    category: 'seo',
    rationale: 'hreflang is only honoured when mutual — correct-looking markup doing nothing.',
  },
  'missing-meta-description': {
    priority: 'P2',
    category: 'seo',
    rationale: 'Search engines will invent the snippet for you.',
  },

  // ---- P3: cleanup ------------------------------------------------------------------
  'title-too-short': { priority: 'P3', category: 'seo', rationale: 'Under-uses the search snippet.' },
  'title-too-long': { priority: 'P3', category: 'seo', rationale: 'Will be truncated in search results.' },
  'description-too-short': { priority: 'P3', category: 'seo', rationale: 'Under-uses the search snippet.' },
  'description-too-long': { priority: 'P3', category: 'seo', rationale: 'Will be truncated in search results.' },
  'missing-og-title': { priority: 'P3', category: 'content', rationale: 'Weak preview when shared.' },
  'missing-og-image': { priority: 'P3', category: 'content', rationale: 'No image when shared.' },
  'missing-og-description': { priority: 'P3', category: 'content', rationale: 'Weak preview when shared.' },
  'missing-html-lang': { priority: 'P3', category: 'seo', rationale: 'Screen readers and translators cannot tell the language.' },
  'missing-alt': { priority: 'P3', category: 'media', rationale: 'Image is invisible to screen readers.' },
  'link-redirects': { priority: 'P3', category: 'availability', rationale: 'Works, but costs a hop.' },
  'link-slow': { priority: 'P3', category: 'availability', rationale: 'Slow to respond — read with suspicion, our own probing inflates this.' },
  'console-warning': { priority: 'P3', category: 'javascript', rationale: 'Warning, not an error.' },
  'page-missing-from-sitemap': { priority: 'P3', category: 'coverage', rationale: 'Crawlable but unlisted — search may never find it.' },
  'llms-txt-coverage': { priority: 'P3', category: 'coverage', rationale: 'Site content that llms.txt does not mention.' },
};

const FALLBACK: RuleMeta = {
  priority: 'P2',
  category: 'content',
  rationale: 'Unclassified rule — add it to RULE_META in src/classify.ts.',
};

export function classify(rule: string): RuleMeta {
  return RULE_META[rule] ?? FALLBACK;
}

/** Issue plus its triage metadata. What the reports actually render. */
export interface ClassifiedIssue extends Issue {
  priority: Priority;
  category: Category;
  rationale: string;
}

export function classifyIssue(issue: Issue): ClassifiedIssue {
  const meta = classify(issue.rule);
  return { ...issue, ...meta };
}

export const PRIORITY_ORDER: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function priorityRank(p: Priority): number {
  return PRIORITY_ORDER.indexOf(p);
}

/**
 * Adds triage metadata for rules a custom check emits.
 *
 * Without this a custom rule falls back to P2/content and lands in the middle of the
 * report with the rationale "add it to RULE_META" — technically visible, practically
 * invisible. Registering is how a custom check gets to say when its findings matter.
 *
 * Builtin rules are not overwritten: a plugin cannot quietly demote 'forbidden-host-in-link'
 * to P3 and make the flagship finding disappear off the bottom of the report.
 */
export function registerRules(meta: Record<string, RuleMeta>): void {
  for (const [rule, m] of Object.entries(meta)) {
    if (rule in RULE_META) continue;
    RULE_META[rule] = m;
  }
}
