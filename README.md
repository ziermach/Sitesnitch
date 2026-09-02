# sitesnitch

Crawls your site in a real browser and reports what it is leaking, breaking and getting
wrong.

The headline check is the one that is hard to catch any other way: **references to your
staging and dev environments that shipped to production**. A staging host reaches
production through more doors than an `<a href>` — an image CDN swapped in a config file, a
canonical tag templated from the wrong env var, a redirect an ops change left behind, an
XHR fired from JavaScript that never appears in the HTML at all. So the check watches five
surfaces: the DOM, every network request the page fires, the redirect chain, inline
script/JSON-LD text, and the final URL.

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
- Plus mixed content, broken images, missing alt text and cookie-consent banners that never
  go away.

Findings land in a filterable HTML report and a `report.json`, ranked P0–P3, and the
process exits non-zero on anything at error severity — so it drops into CI unchanged.

## Install

```bash
npm install --save-dev sitesnitch
```

The postinstall downloads Chromium via Playwright (~150 MB). Node 20+.

## Use it as a library

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

`run()` writes nothing and prints nothing. Pass hooks to watch it work:

```ts
const { report, skipped } = await crawler.run({
  log: console.log,                                    // the CLI's own progress output
  onPage: ({ context, issues }) => publish(context.url, issues),
  onProgress: (done, queued) => bar.update(done, done + queued),
});

console.log(skipped);  // { robots: 412, 'off-site': 88 } — what was NOT crawled
```

Or the one-liner, which crawls *and* writes the reports:

```ts
import { crawl } from 'sitesnitch';

const { report, htmlPath } = await crawl({ baseUrl: 'https://example.com' });
```

### Writing your own checks

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

Registering it is enough to make it run. `page` is a `PageContext`: the DOM snapshot, every
console message, every request the page fired, the redirect chain, axe results, timings.

## Use it from the command line

```bash
npx sitesnitch --url https://example.com --forbidden-hosts staging.example.com
```

Or commit a `sitesnitch.config.ts` (copy `sitesnitch.config.example.ts`) and just run
`npx sitesnitch`. Flags override the file.

```ts
import { defineConfig } from 'sitesnitch';

export default defineConfig({
  baseUrl: 'https://example.com',
  forbiddenHosts: ['staging.example.com', 'dev.example.com'],
  locales: ['en', 'de'],
  excludePaths: ['/blog'],
});
```

Then:

```bash
npx sitesnitch                                 # full site
npx sitesnitch --locales en --max-pages 20     # ~1 min smoke run
npx sitesnitch --only forbidden-hosts          # hunt leaks only — minutes, not an hour
npx sitesnitch --only llms-txt                 # check llms.txt links, skip the crawl
npx sitesnitch --priority P0                   # report only critical findings
npx sitesnitch --help                          # every flag
npx sitesnitch-report                          # serve the last report at 127.0.0.1:8787
```

Two levers that are easy to confuse:

- `--only <checks>` controls what work is **done**. `--only forbidden-hosts` skips link
  probing entirely and finishes in minutes. This is how you make a run cheap.
- `--rules` / `--priority` / `--category` control what is **reported**. The crawl still runs
  in full — a P0 `server-error` is only knowable by fetching the page — they just cut noise.

`--report-only <report.json>` re-renders the reports from a previous run without crawling.

## In CI

```yaml
- run: npx sitesnitch --only forbidden-hosts --fail-on error
```

Severity is a contract, not a label: **error** = definitely broken, fail the build.
**warning** = probably wrong, a human should look. **info** = visible but unactionable
(third-party noise). Any forbidden-host finding is always an error.

## Two things worth knowing before you tune it

**The concurrency defaults are gentle on purpose.** 5 browser contexts, 6 in-flight requests
per origin, a 500 ms delay. An earlier build ran 12 contexts / 32 probes / 100 ms / 64
sockets — each value defensible alone — and collectively turned a QA tool into a load
generator aimed at production: Chromium itself timed out on dozens of pages, ~1,300 healthy
links were reported dead, and real visitors were plausibly served degraded pages. **There
were no 429s.** The server never asked it to slow down; it just stopped answering. Do not
expect a rate-limit response to protect you. `perOriginConcurrency` is the number that
matters — a global cap protects nothing when nearly every URL is on one host.

**Keep `forbiddenHosts` precise.** List exact hosts. Broad wildcards like `dev.*` will flag
`dev.to` and `dev.mysql.com` as leaked internal environments, and a check that cries wolf
about MySQL's documentation is a check people learn to ignore — which is fatal for the one
finding here that must never be ignored.

## Development

```bash
npm install
npm test          # 104 tests, ~3s
npm run lint      # eslint (type-aware) + tsc
npm run check     # both — run this before committing
npm run build     # emit dist/
```

`tests/fixture.e2e.test.ts` is the important one. It serves a page that deliberately leaks
staging hosts through every surface and drives the **real** crawler at it. On a healthy site
the leak check correctly reports nothing — which looks exactly like a check that is broken.
Something has to prove it still fires.

## Licence

MIT — see [LICENSE](LICENSE).
