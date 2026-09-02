# sitesnitch

**Crawls your site in a real browser and reports what it is leaking, breaking and getting wrong.**

[![npm](https://img.shields.io/npm/v/sitesnitch.svg)](https://www.npmjs.com/package/sitesnitch)
[![node](https://img.shields.io/node/v/sitesnitch.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/sitesnitch.svg)](LICENSE)
[![CI](https://github.com/ziermach/Sitesnitch/actions/workflows/ci.yml/badge.svg)](https://github.com/ziermach/Sitesnitch/actions/workflows/ci.yml)

```bash
npx sitesnitch --url https://example.com --forbidden-hosts 'staging.example.com,*.internal.example.com'
```

- [Why](#why)
- [Install](#install)
- [Command line](#command-line)
- [Library](#library)
- [Custom checks](#custom-checks)
- [Configuration](#configuration)
- [CLI flags](#cli-flags)
- [Rules](#rules)
- [Reports](#reports)
- [CI](#ci)
- [Before you tune it](#before-you-tune-it)
- [Development](#development)

## Why

The headline check is the one that is hard to catch any other way: **references to your
staging and dev environments that shipped to production**.

A staging host reaches production through more doors than an `<a href>` — an image CDN
swapped in a config file, a canonical tag templated from the wrong env var, a redirect an
ops change left behind, an XHR fired from JavaScript that never appears in the HTML at all.
Grepping the source misses all of those. So the check watches **five surfaces**:

| surface | catches |
| --- | --- |
| DOM | links, images, scripts, iframes, canonical, hreflang, og:url, form actions |
| network | every request the page actually fired, including ones built at runtime |
| redirect chain | a production URL that routes through staging on its way to a healthy 200 |
| inline scripts | a staging endpoint sitting in a page-config blob, reachable or not |
| final URL | the page you landed on is not the page you asked for |

Alongside that:

- **Dead links and error pages** — 404s, 5xx, unreachable hosts, redirect chains that end
  in an error.
- **JavaScript console errors** — uncaught exceptions, `console.error`, failed subresources.
- **Broken SEO metadata** — missing titles/h1s, `noindex` on live pages, off-site
  canonicals, duplicate titles, non-reciprocal hreflang.
- **Accessibility (WCAG 2.1 A/AA)** — axe-core runs inside the real browser, so it catches
  computed colour contrast, ARIA state and focus order, none of which are visible in HTML
  source.
- **`llms.txt` rot** — it's hand-maintained, so its links die, and a dead entry there is a
  wrong answer served to every AI agent that reads the file.
- Plus mixed content, broken images, missing alt text, and cookie-consent banners that never
  go away.

Findings land in a filterable HTML report and a `report.json`, ranked P0–P3. The process
exits non-zero on anything at error severity, so it drops into CI unchanged.

**Why a real browser?** Two of these can't be met by fetching HTML. Console errors only
exist in a running JS engine, and staging leaks arrive as often through a runtime `fetch()`
or a redirect hop as through markup.

## Install

```bash
npm install --save-dev sitesnitch
```

Node 20+. The postinstall downloads Chromium via Playwright (~150 MB).

## Command line

Point it at a site:

```bash
npx sitesnitch --url https://example.com --forbidden-hosts staging.example.com
```

Or commit a `sitesnitch.config.ts` and just run `npx sitesnitch`. Flags override the file.

```ts
import { defineConfig } from 'sitesnitch';

export default defineConfig({
  baseUrl: 'https://example.com',
  forbiddenHosts: ['staging.example.com', '*.internal.example.com'],
  locales: ['en', 'de'],
  excludePaths: ['/blog'],
});
```

<sub>A TypeScript config needs a TS loader (`node --import tsx node_modules/.bin/sitesnitch`).
`sitesnitch.config.js` and `.mjs` work with plain Node.</sub>

```bash
npx sitesnitch                                 # full site
npx sitesnitch --locales en --max-pages 20     # ~1 min smoke run
npx sitesnitch --only forbidden-hosts          # hunt leaks only — minutes, not an hour
npx sitesnitch --skip accessibility            # everything except one check
npx sitesnitch --only llms-txt                 # check llms.txt links, skip the crawl
npx sitesnitch --priority P0                   # report only critical findings
npx sitesnitch --help                          # every flag
npx sitesnitch-report                          # serve the last report at 127.0.0.1:8787
```

### Two levers, easy to confuse

- **`--only` / `--skip` control what work is *done*.** `--only forbidden-hosts` skips link
  probing entirely and finishes in minutes instead of an hour. This is how you make a run
  cheap.
- **`--rules` / `--priority` / `--category` control what is *reported*.** The crawl still
  runs in full — a P0 `server-error` is only knowable by fetching the page — they just cut
  the noise.

`--report-only <report.json>` re-renders the reports from a previous run without crawling,
so iterating on presentation never costs another crawl against production.

## Library

```ts
import { createCrawler } from 'sitesnitch';

const crawler = createCrawler({
  baseUrl: 'https://example.com',

  // The one setting nobody can guess for you: the environments that must never be
  // reachable from production.
  forbiddenHosts: ['staging.example.com', 'dev.example.com', '*.internal.example.com'],
});

const { report } = await crawler.run();

console.log(report.counts);            // { error: 3, warning: 41, info: 12 }
await crawler.writeReports(report);    // reports/main/report.json + the viewer
process.exit(crawler.exitCode(report));
```

`run()` writes nothing and prints nothing — a library has no business writing to your
stdout uninvited. Pass hooks to watch it work:

```ts
const { report, skipped } = await crawler.run({
  log: console.log,                                    // the CLI's own progress output
  onPage: ({ context, issues }) => publish(context.url, issues),
  onProgress: (done, queued) => bar.update(done, done + queued),
});

console.log(skipped);  // { robots: 412, 'off-site': 88 } — what was NOT crawled
```

That last one matters: the frontier counts every URL it refused and by which rule, so a run
that quietly ignored 400 pages cannot read as "the site is clean".

Or the one-liner, which crawls *and* writes the reports:

```ts
import { crawl } from 'sitesnitch';

const { report, htmlPath } = await crawl({ baseUrl: 'https://example.com' });
```

### API

| export | what it is |
| --- | --- |
| `createCrawler(options)` | validates the config and returns `{ config, run, writeReports, exitCode }` |
| `crawl(options, hooks?)` | crawl **and** write the reports, in one call |
| `runCrawl(options, hooks?)` | the pipeline on its own — returns `{ report, config, skipped }` |
| `writeReports(report, config)` | `report.json` + the shared HTML viewer |
| `defineConfig(options)` | identity function; types a `sitesnitch.config.ts` |
| `resolveConfig(options)` | fill in defaults and validate, without running anything |
| `exitCode(report, failOn)` | the exit code CI should use |
| `classify(rule)` / `RULE_META` | priority, category and rationale for any rule id |
| `printSummary(report)` | the CLI's console summary |
| types | `CrawlerOptions`, `CrawlReport`, `PageContext`, `Issue`, `Check`, `CustomCheck`, … |

## Custom checks

A check is a pure function of what the crawler observed on one page, so a rule specific to
your site is a function, not a fork:

```ts
import { createCrawler, type CustomCheck } from 'sitesnitch';

const pricingPage: CustomCheck = {
  id: 'pricing-page',
  check: (page) => {
    if (!page.url.includes('/pricing')) return [];
    if (page.dom?.inlineScripts.some((s) => s.includes('"price"'))) return [];
    return [{
      check: 'pricing-page',
      severity: 'error',
      rule: 'pricing-page-missing-price',
      message: 'A pricing page with no price on it',
      pageUrl: page.url,
    }];
  },

  // Rank it, or it lands at the report's default P2 with "unclassified rule" as its
  // rationale — visible, but not actionable.
  rules: {
    'pricing-page-missing-price': {
      priority: 'P1',
      category: 'content',
      rationale: 'The page exists to state a price and does not.',
    },
  },
};

const crawler = createCrawler({
  baseUrl: 'https://example.com',
  customChecks: [pricingPage],
});
```

Registering it is enough to make it run; it also becomes selectable via `--only pricing-page`
and `--skip pricing-page`. `page` is a `PageContext`: the DOM snapshot, every console
message, every request the page fired, the redirect chain, axe results, timings.

A custom id may not shadow a builtin one — a silent substitution would leave the report
naming a check that never ran.

## Configuration

Every option, with its default. Only `baseUrl` is required.

### Scope

| option | default | |
| --- | --- | --- |
| `baseUrl` | — | **Required.** The site to crawl. Rejected if empty or not absolute http(s). |
| `locales` | `[]` | Locale path prefixes, e.g. `['en','de']`. Empty = no locale filtering. |
| `includePaths` | `[]` | Crawl **only** these path prefixes. Beats `excludePaths`. |
| `excludePaths` | `[]` | Path prefixes to skip. Matched after the locale segment, so `/blog` covers `/en/blog/…` too. |
| `ignorePatterns` | `mailto:`, `tel:`, `javascript:`, `#`, `/cdn-cgi/`, `.pdf`, `.zip`, `.dmg`, `.exe` | Never crawled, never probed. |
| `maxPages` | `10000` | A cap below your sitemap size silently truncates the crawl. |
| `maxDepth` | `5` | Link depth from a seed. |

### Seeding

| option | default | |
| --- | --- | --- |
| `seedFromSitemap` | `true` | Read `/sitemap.xml` recursively, including sitemap indexes. |
| `extraSitemaps` | `[]` | Sitemaps the main one doesn't link to. |
| `seedFromLlmsTxt` | `true` | Seed from `/llms.txt`, and check its links. |
| `followLinks` | `true` | BFS over links found while crawling. |
| `respectRobots` | `true` | Obey `robots.txt` Disallow rules. |

### The leak check

| option | default | |
| --- | --- | --- |
| `forbiddenHosts` | `['*.ngrok.io','*.ngrok-free.app']` | Hosts that must never appear in production. **Configure this** — see [globs](#before-you-tune-it). |
| `localhostHosts` | `localhost`, `127.0.0.1`, `0.0.0.0`, `*.local` | Judged by surface: fine in an `<a href>` (a tutorial), an error as an asset or XHR. The crawled site's own host is exempt, so pointing this at `localhost:3000` works. |

### Politeness — read [before you tune it](#before-you-tune-it)

| option | default | |
| --- | --- | --- |
| `concurrency` | `5` | Parallel browser contexts. |
| `perOriginConcurrency` | `6` | **The number that protects the site.** Max in-flight requests to one host. |
| `linkConcurrency` | `48` | Global probe workers. Deliberately much larger than the per-origin cap. |
| `delayMs` | `500` | Politeness delay between navigations, per worker. |
| `requestTimeout` | `30000` | Per-page navigation timeout. |
| `linkTimeout` | `10000` | Per link probe. Shorter — we only need headers. |
| `settleMs` | `3000` | Wait for network idle after load. The biggest lever on crawl speed. |
| `userAgent` | `SiteSnitch/0.1 …` | |

### Checks and output

| option | default | |
| --- | --- | --- |
| `checks` | all | Allowlist. `--only`. |
| `disabledChecks` | `[]` | Denylist, applied last — beats `checks`. `--skip`. |
| `customChecks` | `[]` | Your own checks. |
| `rules` / `priorities` / `categories` | `[]` | Filter what is **reported**, not what is done. |
| `failOn` | `'error'` | `error` \| `warning` \| `never`. Drives the exit code. |
| `outDir` | `'reports'` | Reports root. One viewer, one subdirectory per run. |
| `runName` | derived | Names the run's subdirectory, so runs don't overwrite each other. |
| `verbose` | `false` | Log every issue as it's found, not just errors. |
| `slowLinkMs` | `15000` | A link slower than this is a warning. |
| `maxRedirectHops` | `2` | More hops than this is a warning. |
| `seo` | `{ titleMin: 10, titleMax: 70, descriptionMin: 50, descriptionMax: 160 }` | |
| `trackingHosts` | analytics/ad endpoints | Their failures are noise, not defects — downgraded. |
| `botHostileHosts` | facebook, instagram, linkedin, x, twitter, tiktok, reddit | A 4xx from these means "refused *us*", not "broken". |

## CLI flags

| flag | |
| --- | --- |
| `--url <url>`, `--base-url` | Site to crawl (required, unless in the config file) |
| `--forbidden-hosts <a,b>` | Hosts that must never appear in production |
| `--locales <a,b>` | Locale path prefixes |
| `--paths <a,b>` | Crawl **only** these path prefixes |
| `--exclude-paths <a,b>` | Skip these path prefixes |
| `--only <a,b>` | Run only these checks — the lever that makes a run cheap |
| `--skip <a,b>`, `--disable` | Run everything except these checks. Applied last, so it also beats `--only` |
| `--max-pages <n>` / `--max-depth <n>` | Caps |
| `--concurrency <n>` / `--link-concurrency <n>` / `--per-origin <n>` | Parallelism |
| `--settle <ms>` / `--delay <ms>` | Timing |
| `--rules <a,b>` / `--priority <P0,P1>` / `--category <a,b>` | Filter the output |
| `--list-rules` | Print every rule with its priority and category, then exit |
| `--fail-on <level>` | `error` \| `warning` \| `never` |
| `--out <dir>` / `--name <run>` | Where the report goes |
| `--no-sitemap` / `--no-llms-txt` / `--no-follow` / `--ignore-robots` | Turn off seeding sources |
| `-v, --verbose` | Log every issue as it's found |
| `--report-only <json>` | Re-render reports from a previous run, no crawling |
| `-h, --help` | |

## Rules

Every finding carries a **severity** (how sure we are it's wrong — drives the exit code)
and a **priority** (when it should get fixed). They are different questions: a missing
`alt` is a certain defect nobody needs to fix today; a staging link on the pricing page is
both certain and urgent. Sorting 10,000 issues by severity alone puts 670 missing `<h1>`s
ahead of your privacy policy pointing at staging.

62 rules ship today. Run `npx sitesnitch --list-rules` for the current list at any time.

<details>
<summary><b>P0 — Critical, fix now</b> (13 rules)</summary>

| rule | category |
| --- | --- |
| `forbidden-host-in-link` | Staging / Dev leak |
| `forbidden-host-in-resource` | Staging / Dev leak |
| `forbidden-host-in-request` | Staging / Dev leak |
| `forbidden-host-in-canonical` | Staging / Dev leak |
| `forbidden-host-in-redirect` | Staging / Dev leak |
| `forbidden-host-in-hreflang` | Staging / Dev leak |
| `forbidden-host-in-og` | Staging / Dev leak |
| `forbidden-host-in-inline-script` | Staging / Dev leak |
| `forbidden-host-in-text-file` | Staging / Dev leak |
| `server-error` | Broken pages & links |
| `redirect-to-error` | Broken pages & links |
| `navigation-failed` | Broken pages & links |
| `dom-extraction-failed` | Crawl coverage |

</details>

<details>
<summary><b>P1 — High, fix this sprint</b> (18 rules)</summary>

| rule | category |
| --- | --- |
| `a11y-critical`, `a11y-serious` | Accessibility (WCAG) |
| `a11y-audit-failed` | Crawl coverage |
| `client-error` | Broken pages & links |
| `link-dead`, `link-server-error`, `link-unreachable` | Broken pages & links |
| `llms-txt-link-dead`, `llms-txt-link-unreachable` | Broken pages & links |
| `uncaught-exception`, `console-error` | JavaScript errors |
| `subresource-request-failed`, `subresource-error-status` | JavaScript errors |
| `insecure-subresource` | Security |
| `noindex-on-live-page`, `canonical-off-site`, `invalid-canonical` | SEO |
| `consent-banner-missing` | Security |

</details>

<details>
<summary><b>P2 — Medium, schedule it</b> (16 rules)</summary>

| rule | category |
| --- | --- |
| `a11y-moderate` | Accessibility (WCAG) |
| `missing-title`, `missing-h1`, `multiple-h1`, `missing-canonical` | SEO |
| `hreflang-missing-self`, `hreflang-not-reciprocal`, `missing-meta-description` | SEO |
| `broken-image` | Images & media |
| `long-redirect-chain`, `link-refused` | Broken pages & links |
| `llms-txt-link-redirects`, `duplicate-title`, `duplicate-meta-description` | Content quality |
| `consent-banner-not-dismissed`, `consent-banner-check-failed` | Crawl coverage |

</details>

<details>
<summary><b>P3 — Low, cleanup</b> (15 rules)</summary>

| rule | category |
| --- | --- |
| `a11y-minor` | Accessibility (WCAG) |
| `title-too-short`, `title-too-long` | SEO |
| `description-too-short`, `description-too-long`, `missing-html-lang` | SEO |
| `missing-og-title`, `missing-og-image`, `missing-og-description` | Content quality |
| `missing-alt` | Images & media |
| `link-redirects`, `link-slow` | Broken pages & links |
| `console-warning` | JavaScript errors |
| `page-missing-from-sitemap`, `llms-txt-coverage` | Crawl coverage |

</details>

Categories: `environment-leak`, `availability`, `javascript`, `security`, `accessibility`,
`seo`, `media`, `content`, `coverage`.

Accessibility uses axe-core's **impact** rather than one rule per axe rule — axe ships ~100
and adds more each release, so minting a priority per rule would guarantee an unranked one
the first time it did. The axe rule (`color-contrast`, `aria-required-attr`) leads the
message, where the report's search box finds it. Scoped to WCAG 2.1 A/AA: axe's
"best-practice" tag is opinions, not obligations, and mixing it in lets a real WCAG failure
hide behind a hundred stylistic notes.

## Reports

Each run writes `<outDir>/<run>/report.json` and rebuilds one shared HTML viewer at
`<outDir>/index.html`. Runs accumulate side by side rather than overwriting each other, so
a main-site crawl and a `--paths /blog` crawl are two entries in one index.

```bash
npx sitesnitch-report            # serve <outDir> at 127.0.0.1:8787
npx sitesnitch-report dist/qa 9000
```

The viewer fetches `report.json` at runtime rather than baking it in, which keeps the
artifact small and reviewable. It binds to `127.0.0.1` on purpose — a crawl report is a
list of your site's known-broken URLs and, often, your internal hostnames. Don't publish it
anywhere world-readable.

## CI

```yaml
- name: Check production for staging leaks
  run: npx sitesnitch --url https://example.com
        --forbidden-hosts 'staging.example.com,*.internal.example.com'
        --only forbidden-hosts
        --fail-on error
```

A full job, keeping the browser cached between runs:

```yaml
jobs:
  site-qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
      - run: npm ci
      - run: npx playwright install-deps chromium
      - run: npx sitesnitch --only forbidden-hosts --fail-on error
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: sitesnitch-report, path: reports/ }
```

Severity is a contract, not a label:

| severity | meaning |
| --- | --- |
| **error** | Definitely broken. Fail the build. |
| **warning** | Probably wrong. A human should look. |
| **info** | Visible but unactionable — third-party noise. |

Any forbidden-host finding is always an error. There is no acceptable number of staging
links in production.

## Before you tune it

### The concurrency defaults are gentle on purpose

5 browser contexts, 6 in-flight requests per origin, a 500 ms delay.

An earlier build ran 12 contexts / 32 probes / 100 ms / 64 sockets — each value defensible
alone — and collectively turned a QA tool into a load generator aimed at production:
Chromium itself timed out on dozens of pages, ~1,300 healthy links were reported dead, and
real visitors were plausibly served degraded pages. **There were no 429s.** The server never
asked it to slow down; it just stopped answering. Do not expect a rate-limit response to
protect you.

`perOriginConcurrency` is the number that matters — a *global* cap protects nothing when
nearly every URL is on one host. The crawl being slow is not a problem. The crawl hurting
the site is.

### Keep `forbiddenHosts` precise

`*` is a glob: any run of characters, anywhere in the pattern, as often as you like.

| pattern | matches |
| --- | --- |
| `dev.example.com` | that host, exactly |
| `*.internal.example.com` | any subdomain, and `internal.example.com` itself |
| `staging.*` | `staging.example.com`, and bare `staging` |
| `staging-*` | `staging-01`, `staging-eu.example.com` |
| `*-api.example.com` | `eu-api.example.com` |
| `*.example.*` | the same internal site across every TLD you own |
| `a.*.example.com` | a wildcard in the middle |
| `*staging*` | a genuine substring match — you have to ask for it |

Patterns are **anchored at both ends**, which is the point: `staging.*` does not match
`not-staging.example.com`, and `*.example.com` does not match `cdn.example.com.evil.test`.
A pattern with no literal content (`*`, `*.*`) is rejected outright — it would flag every
host on the internet.

Prefer exact hosts anyway. Broad wildcards like `dev.*` will flag `dev.to` and
`dev.mysql.com` as leaked internal environments, and a check that cries wolf about MySQL's
documentation is a check people learn to ignore — which is fatal for the one finding here
that must never be ignored.

### False positives are worse than gaps

Facebook answers automated HEAD requests with 400. `bat.bing.net` beacons are 1×1 pixels
that never decode. Both appear on *every* page, so reporting them as a dead link and a
broken image puts fake errors site-wide. Hence `botHostileHosts` (400/401/403/405/429/999
mean "refused *us*", not "broken") and `trackingHosts`. When you add a check, ask what it
will do on all 3,000 pages, not just the one you're looking at.

## Development

```bash
npm install
npm test          # 115 tests, ~3s
npm run lint      # eslint (type-aware) + tsc --noEmit
npm run check     # both — run this before committing
npm run build     # emit dist/
npm run crawl -- --url https://example.com --max-pages 20   # run from source via tsx
```

`tests/fixture.e2e.test.ts` is the important one. It serves a page that deliberately leaks
staging hosts through every surface and drives the **real** crawler at it.

That test exists because **a clean report is not evidence of a working crawler**. On a
healthy site the leak check correctly reports nothing — which looks exactly like a check
that is broken. An earlier version of this test hand-rolled a copy of the page-visit logic
instead of driving the real crawler; it passed, and missed a bug that had silently disabled
half the checks in production. Test the real path.

Contributions welcome. Please run `npm run check` before opening a PR, and see
[CLAUDE.md](CLAUDE.md) for the architecture and the failure modes this codebase has already
learned the hard way.

## Licence

MIT — see [LICENSE](LICENSE).
