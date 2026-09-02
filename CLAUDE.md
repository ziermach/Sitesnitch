# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                 # deps + Chromium download (postinstall)
npm run crawl -- --url https://example.com   # a crawl, straight from source via tsx
npm run report              # serve the last report at 127.0.0.1:8787
npm test                    # vitest, ~3s
npm run lint                # eslint (type-aware) + tsc --noEmit
npm run check               # lint + tests, run this before committing
npm run build               # emit dist/ (what gets published)
npx vitest run tests/frontier.test.ts        # a single test file
npx vitest run -t 'trailing-slash'           # a single test by name
npm run crawl -- --help                      # all CLI flags
npm run crawl -- --list-rules                # every rule, with priority and category
```

Two different levers, easy to confuse:

- `--only <checks>` controls what work is **done**. `--only forbidden-hosts` skips link
  probing entirely and finishes in minutes — this is how you make a run cheap.
- `--rules` / `--priority` / `--category` control what is **reported**. The crawl still runs
  in full (a P0 `server-error` is only knowable by fetching the page); they just cut the
  noise.

`--report-only <report.json>` re-renders the reports from a previous run without crawling.
Use it whenever you change presentation — iterating on the report must never cost another
hour-long crawl against a production site.

Fast iteration while working on the crawler — a full run is thousands of pages:

```bash
npm run crawl -- --url https://example.com --max-pages 20 --max-depth 1   # ~1 min
npm run crawl -- --url https://example.com --only forbidden-hosts          # one check
npm run crawl -- --url https://example.com --only llms-txt                 # skips the crawl
```

If `npm install` warns about blocked install scripts, esbuild's postinstall must be
approved (`npm approve-scripts esbuild`) or `tsx` and `vitest` won't run.

## Architecture

This is published as a library first and a CLI second. The layering matters:

- **`src/index.ts`** is the public API — `createCrawler`, `crawl`, `defineConfig`, the
  types, and the pieces needed to write a custom check. Anything not exported here is
  private, whatever its `export` keyword says.
- **`src/run.ts`** is the whole pipeline: **seed → crawl → check → cross-page**. It contains
  no process-level behaviour — no argv, no stdout, no `process.exit`. Progress goes through
  an injected `log` hook that defaults to silent, because a library must not write to
  someone else's stdout uninvited.
- **`src/cli.ts`** is a thin wrapper: parse argv, load `sitesnitch.config.*`, call
  `runCrawl`, print, exit. Nothing that belongs to a crawl should live here — if you find
  yourself adding crawl logic to the CLI, it belongs in `run.ts` where the library gets it
  too.

**Seeding.** The frontier is filled from three sources: `/sitemap.xml` (recursively, plus
any `extraSitemaps`), `/llms.txt`, and then BFS over links discovered while crawling.
`robots.txt` is respected by default.

**Two URL populations, deliberately separate.** *Pages* (same-host) are fully rendered in
Chromium and get every check. *Link targets* (everything a page points at, internal and
external) are only status-probed, through `LinkChecker`'s dedup cache — a site's footer
links to the same ~50 URLs from every one of thousands of pages, so each is fetched exactly
once per run. Conflating the two is how a crawler becomes infinite.

**`src/crawler.ts`** owns Chromium: one browser, N contexts, one worker per context. Per
page it attaches listeners (`console`, `pageerror`, `request`, `requestfailed`, `response`)
and then does a **single** `page.evaluate` to snapshot the DOM. Everything a check might
need is captured into a `PageContext`.

**Checks are pure functions of `PageContext`** (`src/checks/`). Builtin ones are registered
in `src/checks/index.ts`; adding one there makes it run on every page, appear in every
report, and become selectable via `--only`, with no other wiring. Library consumers add
their own through `customChecks` without touching that file — a custom id may not shadow a
builtin one, because a silent substitution would leave the report naming a check that never
ran. `llms-txt` and `cross-page` are *not* per-page checks — they run once over the whole
crawl, from `src/crossPage.ts`.

## The things that will bite you

**`page.evaluate` and the `__name` shim.** esbuild (used by both `tsx` and `vitest`)
rewrites named functions to call a module-scope `__name()` helper. Playwright serializes an
evaluate callback to source and runs it in the browser, where that helper doesn't exist —
so the DOM snapshot throws `ReferenceError: __name is not defined`, returns `null`, and
every DOM-dependent check (seo, links, images, mixed-content, and the DOM surfaces of
forbidden-hosts) silently returns nothing. The crawler then reports a clean site while
measuring almost nothing. `installEsbuildNameShim()` in `src/crawler.ts` defines the helper
in the page; it is passed as a **raw source string**, because a function would go through
the very transform it exists to compensate for. If you see checks mysteriously finding
nothing, assert on `ctx.dom` first.

**Trailing slashes are load-bearing.** Many sites serve canonical URLs *with* a trailing
slash and 301 the slashless form. So `normalizeUrl()` **preserves** the slash (fetch what
was authored), while `dedupeKey()` strips it (identity: `/en/vps` and `/en/vps/` are one
page). Use `normalizeUrl` for fetching, `dedupeKey` for "have I seen this?". Stripping the
slash in normalization made every URL on such a site look like a redirect — hundreds of
false warnings and a wasted request each.

**A clean report is not evidence of a working crawler.** The forbidden-host check is the
reason this tool exists, and on a healthy site it correctly reports nothing — which looks
exactly like a check that is broken. `tests/fixture.e2e.test.ts` serves a deliberately
leaky page and drives the **real** `Crawler` at it, asserting all five surfaces fire. Do
not "simplify" it into a hand-rolled copy of the page-visit logic: an earlier version did
exactly that, passed, and missed the `__name` bug that had disabled half the checks in
production. Test the real path.

The same principle is why a failed DOM snapshot is itself a reported error
(`dom-extraction-failed`, `ctx.domError`), emitted from `run.ts` regardless of which checks
were enabled. A page we couldn't read is a hole in the crawl's coverage, and a hole must
never be able to masquerade as a clean page. Resist any refactor that reintroduces a bare
`.catch(() => null)` around the snapshot.

**`slim()` in `run.ts` prunes each `PageContext` after its checks run**, dropping links,
images, resources, inline scripts, request URLs and console entries — thousands of strings
per page, across thousands of pages. It keeps exactly what the cross-page pass still reads:
identity, title, description, hreflang. If you add a cross-page check that needs another
field, `slim()` is what deleted it.

**Do not turn up the concurrency.** `concurrency: 5`, `linkConcurrency: 48`,
`perOriginConcurrency: 6`, `delayMs: 500` are gentle on purpose. A previous build ran 12
contexts / 32 probes / 100ms / 64 sockets — each value defensible in isolation — and
collectively turned this QA tool into a load generator aimed at production: Chromium itself
timed out after 30s on 43 pages, ~1,300 healthy links were reported dead, and real visitors
were plausibly served degraded pages. **There were no 429s.** The server never asked us to
slow down; it just stopped answering. Do not expect a rate-limit response to protect you.

`PerOriginThrottle` (`src/throttle.ts`) is the limit that actually matters — a *global* cap
protects nothing when nearly every URL is on one host. Two invariants:

- The undici pool is sized to the per-origin cap, never above it. Widening the pool doesn't
  fix a pile-up, it just moves the queue from our process onto the site's accept queue.
- The `linkTimeout` clock starts **inside** the throttle. Start it outside and a probe can
  exhaust its budget queueing behind our own politeness and be reported dead without a
  request ever being sent — the phantom-timeout bug, reintroduced.

The crawl being slow is not a problem. The crawl hurting the site is.

**Defaults must be safe for a stranger's site.** `baseUrl` has no default and
`resolveConfig()` rejects an empty one — a crawler pointed somewhere arbitrary by accident
is worse than one that refuses to start. `forbiddenHosts` ships with only tunnel services
(`*.ngrok.io`) because only the site's owner knows their own internal hostnames, and
`locales` / `excludePaths` ship empty for the same reason. Any default that encodes one
particular site's shape is a bug in a published library.

Relatedly: the forbidden-host check exempts the crawled site's **own** host from
`localhostHosts`. Pointing the crawler at `http://localhost:3000` is a normal thing to do
against a dev server or in CI, and without the exemption every asset and every XHR on every
page is reported as a localhost leak — hundreds of false errors on the one check that must
never cry wolf.

**Accessibility uses axe-core's impact, not one rule per axe rule.** axe ships ~100 rules
and adds more each release; minting a priority for each would guarantee an unranked rule the
first time it did. So the rule id is the *impact* (`a11y-critical` … `a11y-minor`) and the
axe rule (`color-contrast`, `aria-required-attr`) leads the message, where the report's
search box finds it. Scoped to WCAG 2.1 A/AA — axe's "best-practice" tag is opinions, not
obligations, and mixing it in would let a real WCAG failure hide behind a hundred stylistic
notes. axe runs *after* the consent banner is dismissed, or you audit the cookie dialog's
accessibility instead of the site's.

**False positives are worse than gaps.** Facebook answers automated HEAD requests with 400;
`bat.bing.net` beacons are 1×1 pixels that never decode. Both appear on *every* page, so
reporting them as a dead link and a broken image put fake errors site-wide. Hence
`REFUSAL_STATUSES` in `src/checks/links.ts` (400/401/403/405/429/999 mean "refused *us*",
not "broken") and `trackingHosts` / `botHostileHosts` in `src/config.ts`. When adding a
check, ask what it will do on all 3000 pages, not just the one you're looking at.

## Conventions

Severity drives the exit code (`--fail-on`, default `error`), so it's a real contract, not
a label: **error** = definitely broken, fail the build. **warning** = probably wrong, a
human should look. **info** = visible but unactionable (third-party noise). Any
forbidden-host finding is always an error — there is no acceptable number of staging links
in production.

`Frontier` counts every skip by reason rather than dropping URLs silently, the pipeline
returns those counts as `skipped`, and the CLI prints them. A run that quietly ignored 400
URLs must not read as "the site is clean".

Nothing in this repository may reference a specific real site: no company names, no internal
hostnames, no committed crawl output. `reports/` is gitignored — a report names every broken
URL on the site it was run against, and often its internal hostnames. Test fixtures use
`example.com`, `staging.example.com` and `dev.example.com`.
