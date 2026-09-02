import { registerRules, type RuleMeta } from './classify.js';
import type { BuiltinCheckId, Check, CheckId, Severity } from './types.js';

/**
 * A check written by a consumer of the library.
 *
 * The crawler already captures everything a check could want in a PageContext, so a
 * project-specific rule ("every product page must carry a price", "no link to the old
 * pricing anchor") is a pure function, not a fork.
 */
export interface CustomCheck {
  /** Id used in `checks`, in `--only`, and on every Issue this check emits. */
  id: string;
  check: Check;
  /**
   * Triage metadata for the rules this check emits, keyed by rule id.
   *
   * Skip it and every finding lands at the report's default P2/content with a rationale
   * telling the reader the rule was never classified — visible, but not actionable.
   */
  rules?: Record<string, RuleMeta>;
}

export interface CrawlerConfig {
  /** Site to crawl, e.g. 'https://example.com'. The only required option. */
  baseUrl: string;
  /** Locale path prefixes to crawl, e.g. ['en', 'de']. Empty = no locale filtering. */
  locales: string[];
  /** Seed the frontier from sitemap.xml (recursively, incl. sitemap indexes). */
  seedFromSitemap: boolean;
  /** Extra sitemap URLs not reachable from the main sitemap (e.g. a sub-site's own index). */
  extraSitemaps: string[];
  /** Seed the frontier from llms.txt, and check its links. */
  seedFromLlmsTxt: boolean;
  /** Follow links discovered on crawled pages (BFS). */
  followLinks: boolean;
  maxPages: number;
  maxDepth: number;
  /** Parallel browser contexts. */
  concurrency: number;
  /** Parallel link status probes. */
  linkConcurrency: number;
  /** Max simultaneous in-flight requests to any one origin. See DEFAULT_CONFIG. */
  perOriginConcurrency: number;
  /** Per-page navigation timeout, ms. */
  requestTimeout: number;
  /**
   * How long to wait after DOMContentLoaded for the network to go quiet.
   *
   * This is the single biggest lever on crawl speed: it's paid on every page. It buys us
   * late-firing XHRs (the runtime staging-host leak) and late exceptions, but ad and
   * analytics traffic means many pages never truly go idle, so most of this budget is
   * spent waiting for trackers we don't care about.
   */
  settleMs: number;
  /** Timeout for a link status probe, ms. Shorter than requestTimeout — we only need headers. */
  linkTimeout: number;
  /** Politeness delay between navigations, per worker, ms. */
  delayMs: number;
  /**
   * How many times a rate-limited page is re-queued before we give up and report it as
   * unmeasured. 0 disables retrying.
   */
  blockedRetries: number;
  /** First cooldown after an origin returns 429. Doubles per consecutive strike. */
  rateLimitBackoffMs: number;
  /** Ceiling on one cooldown, however long a Retry-After the server sends. */
  maxRateLimitBackoffMs: number;
  respectRobots: boolean;
  /**
   * Hosts that must never appear in production output — your own staging and dev
   * environments. Glob patterns: `*` stands for any run of characters, anywhere in the
   * pattern and as often as you like — '*.local', 'staging.*', 'staging-*',
   * '*-api.example.com', '*.example.*', 'a.*.example.com'. Patterns are anchored at both
   * ends, so 'staging.*' does not match 'not-staging.example.com'; write '*staging*' if you
   * genuinely want a substring match. See hostMatches() in url.ts.
   *
   * This is the check the tool exists for, and it is the one you must configure: nobody
   * else can know what your internal hostnames are. See DEFAULT_CONFIG for why the
   * defaults are near-empty rather than a helpful-looking list of wildcards.
   */
  forbiddenHosts: string[];
  /** Local addresses: an error on asset/network surfaces, ignored in prose links. */
  localhostHosts: string[];
  /**
   * Path prefixes to skip. Matched after the locale segment, so '/blog' covers
   * /blog/..., /en/blog/... and /blog/de/... alike.
   *
   * Use this to keep a sub-site that has its own codebase, sitemap and owners out of the
   * main report: its issues land on a team that cannot fix them, and its page count can
   * bury everything else. Crawl it on its own instead: `--paths /blog`.
   */
  excludePaths: string[];
  /**
   * If set, crawl ONLY these path prefixes. Takes precedence over excludePaths — this is
   * how you scope a run to one sub-site (`--paths /blog`).
   */
  includePaths: string[];
  /** URL substrings/globs to skip entirely (never crawl, never status-check). */
  ignorePatterns: string[];
  /** Analytics/ad endpoints whose failures are noise, not defects. */
  trackingHosts: string[];
  /** Hosts that refuse bots with 4xx. A refusal is not a dead link. */
  botHostileHosts: string[];
  /** Checks to run. Omit a check id to disable it. */
  checks: CheckId[];
  /**
   * Checks written by the caller, run alongside the builtin ones.
   *
   * Their ids are added to `checks` automatically unless `checks` was set explicitly, so
   * registering a check is enough to make it run — but naming it in `--only` still works,
   * and still makes the run cheap.
   */
  customChecks: CustomCheck[];
  /**
   * Checks NOT to run, subtracted from `checks` after everything else is resolved.
   *
   * `checks` is an allowlist and answers "run only these". This is the denylist, and
   * answers the far more common "run everything except this one" — without it, switching
   * off a single noisy check means writing out the other ten and then remembering to come
   * back and edit that list every time a new check ships.
   *
   * Applied last, so it wins over `checks` and over the ids `customChecks` contributes.
   */
  disabledChecks: CheckId[];
  /**
   * Report only these specific rules / priorities / categories. Empty means "all".
   *
   * `checks` decides what work is *done*; these decide what is *reported*. The distinction
   * matters: --only forbidden-hosts skips link probing entirely and finishes in minutes,
   * whereas --priority P0 still runs everything (a P0 server-error can only be found by
   * looking) and just filters the output. Use --only to go fast, these to cut the noise.
   */
  rules: string[];
  priorities: string[];
  categories: string[];
  /** Exit non-zero when an issue at or above this severity is found. */
  failOn: Severity | 'never';
  /**
   * Root for all reports. One viewer lives here; each run gets its own subdirectory, so
   * runs accumulate side by side (main site, sub-site, a one-off leak sweep) instead of
   * overwriting each other.
   */
  outDir: string;
  /** Subdirectory for this run. Defaults to the scope being crawled ('main', 'blog', …). */
  runName: string;
  userAgent: string;
  /** Log every issue as it's found, not just errors. */
  verbose: boolean;
  /** SEO thresholds. */
  seo: {
    titleMin: number;
    titleMax: number;
    descriptionMin: number;
    descriptionMax: number;
  };
  /**
   * A link slower than this is a warning.
   *
   * Read this number with suspicion: probes run many-at-once, so a "slow" link may just
   * have been queued behind our own requests. It's a smoke signal for a genuinely
   * struggling endpoint, not a latency measurement. Kept high on purpose.
   */
  slowLinkMs: number;
  /** More redirect hops than this is a warning. */
  maxRedirectHops: number;
}

/**
 * What a caller passes in. Everything has a default except the site to crawl, which
 * nothing sensible can be guessed for.
 */
export type CrawlerOptions = Partial<CrawlerConfig> & { baseUrl: string };

export type ResolvedConfig = CrawlerConfig;

export const ALL_CHECKS: BuiltinCheckId[] = [
  'http-status',
  'console-errors',
  'forbidden-hosts',
  'seo',
  'links',
  'mixed-content',
  'images',
  'accessibility',
  'llms-txt',
  'cross-page',
  'consent-banner',
];

export const DEFAULT_CONFIG: CrawlerConfig = {
  // No default: resolveConfig() rejects an empty baseUrl rather than crawling something
  // arbitrary. A crawler pointed at the wrong site by accident is worse than one that
  // refuses to start.
  baseUrl: '',
  locales: [],
  seedFromSitemap: true,
  extraSitemaps: [],
  seedFromLlmsTxt: true,
  excludePaths: [],
  includePaths: [],
  followLinks: true,
  // Sized so the cap is not what ends a normal run: a mid-size site's sitemap alone can
  // list a few thousand URLs, and link-following finds more. A cap below that silently
  // truncates the crawl and reports a "clean" partial site.
  maxPages: 10_000,
  maxDepth: 5,

  /**
   * These numbers are deliberately gentle, and they are not a knob to turn up casually.
   *
   * An earlier build of this crawler ran 12 contexts / 32 probes / 100ms delay / 64
   * sockets against a live production site. Each value looked defensible alone; together
   * they turned a QA tool into a load generator: Chromium itself began timing out after
   * 30s on 43 pages, hundreds of perfectly healthy links were reported dead, and real
   * visitors were plausibly served degraded pages. Notably there were no 429s — the server
   * never said "slow down", it simply stopped answering. Do not expect a rate-limit
   * response to protect you.
   *
   * You are measuring a live site that people are trying to use. The crawl being slow is
   * not a problem. The crawl hurting the site is.
   */
  concurrency: 5,

  /**
   * Global probe workers. Deliberately much larger than perOriginConcurrency, and that
   * relationship is the whole design — do not "tidy" them to the same number.
   *
   * perOriginConcurrency is what protects the site under test. linkConcurrency only bounds
   * how many probes may be in flight *anywhere*, and those are cheap. Setting it to 8
   * (barely above the per-origin cap) meant a few dozen slow or dead external links — each
   * burning a 15s timeout plus a retry — permanently occupied every worker and starved the
   * queue: 15 links/min, while the site under test was answering HEAD in under a second.
   * Politeness to one host must not be paid for by head-of-line blocking on another.
   */
  linkConcurrency: 48,

  /**
   * Max in-flight requests to any single origin. THIS is the number that protects the site;
   * a global limit alone throttles nothing when nearly every URL is on one host.
   */
  perOriginConcurrency: 6,

  requestTimeout: 30_000,
  settleMs: 3_000,
  // A healthy host answers a HEAD in well under a second. 15s was buying nothing but a
  // longer stall on hosts that were never going to answer.
  linkTimeout: 10_000,
  delayMs: 500,

  /**
   * What to do when a host says 429.
   *
   * The standing lesson elsewhere in this file is that you cannot *rely* on a rate-limit
   * response — a site driven into the ground never sent one, it simply stopped answering. That
   * is an argument for staying slow by default, not for ignoring hosts that do speak up. One site
   * sent 484 in a single run; the crawler noted every one of them, changed nothing, and
   * finished with 485 pages it had never actually read.
   *
   * Two retries at a doubling cooldown is enough for a burst limit to reset without the
   * run turning into an argument with the WAF: if a host is still refusing after ~30s of
   * waiting, it means it, and the page is reported as unmeasured instead.
   */
  blockedRetries: 2,
  rateLimitBackoffMs: 10_000,
  maxRateLimitBackoffMs: 60_000,

  respectRobots: true,

  /**
   * Internal environments that must never appear in production output. The whole point of
   * the exercise — and empty by default, because only you know your own hostnames.
   *
   * Configure it with the *exact* hosts you own:
   *
   *   forbiddenHosts: ['staging.example.com', 'dev.example.com', '*.internal.example.com']
   *
   * Resist the temptation to add broad wildcards. An earlier version of this list carried
   * `dev.*`, `staging.*` and `test.*`, which promptly flagged `dev.to` (a developer blog)
   * and `dev.mysql.com` (MySQL's own documentation) as leaked internal environments. A
   * check that cries wolf about MySQL's docs is a check people learn to ignore — and this
   * is the one finding in the whole tool that must never be ignored. Precision here is
   * worth more than reach: a leak to some unlisted internal host is a miss, but a false
   * accusation against every finding is a discredited report.
   *
   * The two defaults are tunnel services. Nobody's production site should ever reference
   * one, and they belong to no particular company, so they are safe to ship on.
   */
  forbiddenHosts: ['*.ngrok.io', '*.ngrok-free.app'],

  /**
   * Local-machine addresses. These need surface-sensitive treatment, which is why they are
   * not in `forbiddenHosts`.
   *
   * A blog post teaching you to run Ollama locally *should* contain the text
   * `http://localhost:11434` — that is correct content, not a defect. But the page's own
   * stylesheet or an XHR pointing at localhost is a shipped bug that breaks for every
   * visitor. Same host, opposite meaning, decided entirely by which surface it appears on:
   * ignored in `a[href]`, an error everywhere else.
   */
  localhostHosts: ['localhost', '127.0.0.1', '0.0.0.0', '*.local'],

  ignorePatterns: [
    'mailto:',
    'tel:',
    'javascript:',
    '#',
    '/cdn-cgi/',
    '.pdf',
    '.zip',
    '.dmg',
    '.exe',
  ],

  /**
   * Analytics and advertising endpoints. Their "images" are 1x1 beacons that never decode,
   * which is not a broken image, and their scripts fail loudly when a tracker is blocked.
   * Findings about these are noise we can neither fix nor act on, so they're downgraded.
   */
  trackingHosts: [
    // Third-party assets we neither own nor can fix. Google Fonts in particular gets
    // ERR_BLOCKED_BY_ORB in headless Chrome once a consent layer intercepts it — a crawler
    // artifact, not a site defect, and it fires on essentially every page. Left at 'error'
    // it contributed ~600 of 1,355 errors in a real run and buried the genuine ones.
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'bat.bing.net',
    'google-analytics.com',
    'googletagmanager.com',
    'googleadservices.com',
    'doubleclick.net',
    'facebook.net',
    'facebook.com/tr',
    'connect.facebook.net',
    'hotjar.com',
    'clarity.ms',
    'linkedin.com/px',
    'px.ads.linkedin.com',
    'snap.licdn.com',
    'analytics.tiktok.com',
    'reddit.com/rp.gif',
    't.co/i/adsct',
  ],

  /**
   * Hosts that answer automated requests with 400/403 as an anti-bot measure. A refusal
   * is not a dead link — it says something about the crawler, not about the URL — so
   * these are reported as warnings rather than errors.
   */
  botHostileHosts: [
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'x.com',
    'twitter.com',
    'tiktok.com',
    'reddit.com',
  ],

  checks: ALL_CHECKS,
  customChecks: [],
  disabledChecks: [],
  rules: [],
  priorities: [],
  categories: [],
  failOn: 'error',
  verbose: false,
  outDir: 'reports',
  runName: '',
  userAgent:
    'SiteSnitch/0.1 (+https://github.com/ziermach/Sitesnitch; Playwright) Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  seo: {
    titleMin: 10,
    titleMax: 70,
    descriptionMin: 50,
    descriptionMax: 160,
  },

  slowLinkMs: 15_000,
  maxRedirectHops: 2,
};

export function mergeConfig(
  base: CrawlerConfig,
  overrides: Partial<CrawlerConfig>,
): ResolvedConfig {
  return {
    ...base,
    ...overrides,
    seo: { ...base.seo, ...(overrides.seo ?? {}) },
  };
}

/**
 * Fills in the defaults and rejects a configuration that cannot produce a meaningful run.
 *
 * Validation happens here, once, rather than in the CLI: the SDK entry point and the CLI
 * both go through it, so `createCrawler({ baseUrl: 'example.com' })` fails the same way
 * `--url example.com` does instead of only surfacing as a confusing error mid-crawl.
 */
export function resolveConfig(options: CrawlerOptions): ResolvedConfig {
  const config = mergeConfig(DEFAULT_CONFIG, options);

  if (!config.baseUrl) {
    throw new Error('baseUrl is required, e.g. { baseUrl: "https://example.com" }');
  }

  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid absolute URL: ${config.baseUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`baseUrl must be http(s), got: ${config.baseUrl}`);
  }

  // A pattern with no literal content — '*', '**', '*.*' — matches every host there is,
  // which would turn every link, asset and request on the site into a forbidden-host error.
  // That is never what anyone meant, and the failure mode is a report so loud it gets
  // ignored, taking the genuine leaks down with it.
  for (const pattern of [...config.forbiddenHosts, ...config.localhostHosts]) {
    if (pattern.replace(/[*.]/g, '') === '') {
      throw new Error(
        `Host pattern '${pattern}' matches every host. Name the environments you actually ` +
          "own, e.g. 'staging.example.com' or '*.internal.example.com'.",
      );
    }
  }

  const customIds = config.customChecks.map((c) => c.id);

  const collision = customIds.find((id) => (ALL_CHECKS as string[]).includes(id));
  if (collision) {
    throw new Error(
      `Custom check id '${collision}' collides with a builtin check. Pick another id — ` +
        'shadowing a builtin would leave the report claiming a check ran that did not.',
    );
  }

  const known = [...ALL_CHECKS, ...customIds];
  const unknown = config.checks.filter((c) => !known.includes(c));
  if (unknown.length > 0) {
    throw new Error(`Unknown check(s): ${unknown.join(', ')}. Known checks: ${known.join(', ')}`);
  }

  // A typo in the denylist is worse than a typo in the allowlist: `--only acessibility`
  // runs nothing and is obvious within seconds, whereas `--skip acessibility` runs the
  // check you were trying to switch off and looks entirely normal. Reject both.
  const unknownDisabled = config.disabledChecks.filter((c) => !known.includes(c));
  if (unknownDisabled.length > 0) {
    throw new Error(
      `Unknown disabled check(s): ${unknownDisabled.join(', ')}. Known checks: ${known.join(', ')}`,
    );
  }

  // Registering a custom check is enough to make it run. Only when the caller named
  // `checks` explicitly do we take that list at its word — that is them saying "only
  // these", and silently appending would break --only.
  if (options.checks === undefined) {
    config.checks = [...config.checks, ...customIds];
  }

  // Subtracted last so it beats both the allowlist and the custom-check ids: "everything
  // except X" must mean that however X got into the list.
  if (config.disabledChecks.length > 0) {
    config.checks = config.checks.filter((c) => !config.disabledChecks.includes(c));

    if (config.checks.length === 0) {
      throw new Error(
        'Every check is disabled, so the crawl would visit every page and report nothing. ' +
          'Narrow `disabledChecks`, or use `rules`/`priorities`/`categories` to filter the ' +
          'output of a run that still does the work.',
      );
    }
  }

  for (const custom of config.customChecks) {
    if (custom.rules) registerRules(custom.rules);
  }

  return config;
}

/**
 * Identity function that types a config object in a `sitesnitch.config.ts` file.
 *
 * Purely for editor support — it gives you completion and type errors in a config file
 * that is otherwise just an untyped default export.
 */
export function defineConfig(options: CrawlerOptions): CrawlerOptions {
  return options;
}
