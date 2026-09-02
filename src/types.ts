export type Severity = 'error' | 'warning' | 'info';

/** The checks that ship with the crawler. */
export type BuiltinCheckId =
  | 'http-status'
  | 'console-errors'
  | 'forbidden-hosts'
  | 'seo'
  | 'links'
  | 'mixed-content'
  | 'images'
  | 'accessibility'
  | 'llms-txt'
  | 'cross-page'
  | 'consent-banner';

/**
 * A check id. Any string is legal so that a custom check registered through
 * `customChecks` can carry its own id, while the builtin ids still autocomplete.
 */
export type CheckId = BuiltinCheckId | (string & {});

/** axe-core's own severity for a violation. */
export type AxeImpact = 'critical' | 'serious' | 'moderate' | 'minor';

/** One accessibility violation, as axe-core reports it. */
export interface AxeViolation {
  /** axe rule id, e.g. 'color-contrast', 'image-alt', 'aria-required-attr'. */
  id: string;
  impact: AxeImpact;
  /** Human-readable statement of what is wrong. */
  help: string;
  helpUrl: string;
  /** WCAG success criteria this maps to, e.g. ['wcag2aa', 'wcag143']. */
  tags: string[];
  /** CSS selectors of the offending elements. Capped — a page can violate one rule 200×. */
  nodes: string[];
  /** How many elements violated it in total, before the cap. */
  nodeCount: number;
  /** axe's explanation of why these specific nodes failed. */
  failureSummary?: string;
}

/** A single problem found on (or about) one page. */
export interface Issue {
  check: CheckId;
  severity: Severity;
  /** Stable machine-readable rule id, e.g. 'missing-title'. Used for grouping in reports. */
  rule: string;
  /** Human-readable one-liner. */
  message: string;
  /** The page the issue was found on. */
  pageUrl: string;
  /** The offending URL, if the issue is about a URL (link target, asset, redirect hop). */
  target?: string;
  /** Where on the page it came from: a CSS-ish selector, 'network', 'redirect-chain', 'inline-script'. */
  where?: string;
  /** Extra context — status codes, stack traces, measured values. */
  detail?: string;
}

/** Result of a HEAD/GET status probe. Cached per URL in linkChecker. */
export interface LinkStatus {
  url: string;
  /** Final status after redirects. 0 when the request failed outright (DNS, TLS, timeout). */
  status: number;
  /** Final URL after redirects, if different. */
  finalUrl?: string;
  /** Number of redirect hops. */
  redirects: number;
  /** Error message when status === 0. */
  error?: string;
  /** Wall-clock ms. */
  durationMs: number;
}

/** A console message or uncaught error captured from the browser. */
export interface ConsoleEntry {
  type: 'error' | 'warning' | 'pageerror';
  text: string;
  location?: string;
}

/** A request the page fired that failed or returned >= 400. */
export interface FailedRequest {
  url: string;
  /** 0 when the request never got a response (blocked, DNS, aborted). */
  status: number;
  method: string;
  resourceType: string;
  failure?: string;
}

/** Everything extracted from the DOM in a single page.evaluate(). */
export interface DomSnapshot {
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  canonical: string | null;
  htmlLang: string | null;
  h1s: string[];
  og: Record<string, string>;
  /** hreflang -> href */
  hreflang: Array<{ hreflang: string; href: string }>;
  links: Array<{ href: string; text: string; rel: string | null }>;
  images: Array<{ src: string; alt: string | null; naturalWidth: number }>;
  /** src of <script>, <iframe>, <source>, plus form[action] — everything that can point off-site. */
  resources: Array<{ url: string; where: string }>;
  /** Raw text of inline <script> and JSON-LD blocks, for regex scanning. */
  inlineScripts: string[];
  /** True if a cookie-consent overlay is still visible after load. */
  consentBannerVisible: boolean;
}

/** Everything the crawler observed for one page. Checks are pure functions of this. */
export interface PageContext {
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  /** Redirect hops, in order, excluding the final URL. */
  redirectChain: string[];
  depth: number;
  /** Where this URL was found: the linking page's URL, or 'sitemap' / 'llms.txt'. */
  source: string;
  loadMs: number;
  /**
   * How many times we fetched this URL, including retries after a rate limit. 1 for almost
   * every page; higher means the host pushed back and we waited and came again.
   */
  attempts?: number;
  dom: DomSnapshot | null;
  console: ConsoleEntry[];
  failedRequests: FailedRequest[];
  /** Every request URL the page fired. Feeds the forbidden-host network surface. */
  requestUrls: string[];
  /** axe-core violations. Null when the accessibility check is off or axe failed to run. */
  axe: AxeViolation[] | null;
  /** Why axe didn't run, if it was meant to. Never silent — see domError. */
  axeError?: string;
  /** Navigation-level failure (timeout, DNS). When set, dom is null. */
  navigationError?: string;
  /**
   * The page loaded, but snapshotting its DOM threw. `dom` is null and every DOM-dependent
   * check will therefore find nothing — which is emphatically not the same as the page
   * being clean. Never let this be silent.
   */
  domError?: string;
}

/** Final result for one page: what we saw plus what was wrong with it. */
export interface PageResult {
  context: PageContext;
  issues: Issue[];
}

export interface CrawlReport {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesCrawled: number;
  linksChecked: number;
  pages: PageResult[];
  /** Issues not attributable to a single crawled page: llms.txt findings, cross-page findings. */
  globalIssues: Issue[];
  counts: Record<Severity, number>;
}

export type Check = (ctx: PageContext, deps: CheckDeps) => Issue[] | Promise<Issue[]>;

export interface CheckDeps {
  config: import('./config.js').ResolvedConfig;
  /** Status of any URL the crawler has probed. Populated before checks run. */
  linkStatus: (url: string) => LinkStatus | undefined;
}
