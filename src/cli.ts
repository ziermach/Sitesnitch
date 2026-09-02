#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RULE_META,
} from './classify.js';
import {
  ALL_CHECKS,
  DEFAULT_CONFIG,
  mergeConfig,
  type CrawlerConfig,
  type CrawlerOptions,
} from './config.js';
import { printSummary } from './report/console.js';
import { writeHtmlReport } from './report/html.js';
import { exitCode, runCrawl, writeReports } from './run.js';
import type { CrawlReport, Severity } from './types.js';

const CONFIG_FILES = ['sitesnitch.config.ts', 'sitesnitch.config.js', 'sitesnitch.config.mjs'];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const reportOnlyIdx = argv.indexOf('--report-only');
  if (reportOnlyIdx !== -1) {
    const jsonPath = argv[reportOnlyIdx + 1];
    if (!jsonPath) throw new Error('--report-only needs a path to a report.json');
    await renderOnly(jsonPath);
  }

  const options = await loadOptions(argv);

  const { report, config, skipped } = await runCrawl(options, { log: console.log });
  const { jsonPath, htmlPath } = await writeReports(report, config);

  printSummary(report);

  if (Object.keys(skipped).length > 0) {
    // Say what we didn't crawl. A run that silently skipped 400 URLs on a robots rule
    // should not read as "the whole site is clean".
    console.log(
      `Skipped: ${Object.entries(skipped).map(([reason, n]) => `${n} ${reason}`).join(', ')}`,
    );
    console.log();
  }

  console.log(`Reports: ${jsonPath}`);
  console.log(`         ${htmlPath}`);
  console.log();

  process.exit(exitCode(report, config.failOn));
}

/**
 * Re-renders the reports from a previous run's report.json, without crawling.
 *
 * A full crawl costs an hour of wall-clock and a lot of requests against a production site.
 * Iterating on how findings are presented — priorities, categories, filters — must not
 * require paying that again, or the presentation simply doesn't get iterated on.
 */
async function renderOnly(jsonPath: string): Promise<never> {
  const { readFile } = await import('node:fs/promises');
  const report = JSON.parse(await readFile(jsonPath, 'utf8')) as CrawlReport;

  // The JSON already sits in its run directory; rebuild the viewer and index around it
  // rather than moving anything.
  const runDir = dirname(resolve(jsonPath));
  const htmlPath = await writeHtmlReport(report, runDir);

  printSummary(report);
  console.log(`Re-rendered the viewer and index from ${jsonPath}`);
  console.log(`Open: ${htmlPath}  (npx sitesnitch-report)`);
  process.exit(0);
}

// --- config ------------------------------------------------------------------

/**
 * Config file from the working directory, then CLI flags on top.
 *
 * Precedence is flags > config file > defaults, so a one-off `--max-pages 20` never has to
 * fight the committed configuration.
 */
async function loadOptions(argv: string[]): Promise<CrawlerOptions> {
  const fileConfig = await loadConfigFile();
  const flags = parseArgs(argv);
  const merged = mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), flags);

  if (!merged.baseUrl) {
    console.error(
      'No site to crawl.\n\n' +
        `Pass --url https://example.com, or create a ${CONFIG_FILES[0]}:\n\n` +
        "  import { defineConfig } from 'sitesnitch';\n\n" +
        '  export default defineConfig({\n' +
        "    baseUrl: 'https://example.com',\n" +
        "    forbiddenHosts: ['staging.example.com'],\n" +
        '  });\n',
    );
    process.exit(2);
  }

  return merged;
}

async function loadConfigFile(): Promise<Partial<CrawlerConfig>> {
  for (const name of CONFIG_FILES) {
    const path = resolve(process.cwd(), name);
    try {
      const mod = (await import(pathToFileURL(path).href)) as { default?: Partial<CrawlerConfig> };
      return mod.default ?? {};
    } catch (err) {
      // A missing file is the normal case. A file that exists but fails to load is not:
      // silently falling back to the defaults would crawl the wrong site with the wrong
      // forbidden-host list and report it clean.
      if (!isModuleNotFound(err, path)) {
        console.error(`Failed to load ${name}:\n${String(err)}\n`);
        if (name.endsWith('.ts')) {
          console.error('A TypeScript config needs a TypeScript loader, e.g. `node --import tsx`.');
        }
        process.exit(2);
      }
    }
  }
  return {};
}

function isModuleNotFound(err: unknown, path: string): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' && String(err).includes(path);
}

function parseArgs(argv: string[]): Partial<CrawlerConfig> {
  const overrides: Partial<CrawlerConfig> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    const list = (): string[] => next().split(',').map((s) => s.trim()).filter(Boolean);

    switch (arg) {
      case '--url':
      case '--base-url':
        overrides.baseUrl = next();
        break;
      case '--locales':
        overrides.locales = list();
        break;
      case '--forbidden-hosts':
        overrides.forbiddenHosts = list();
        break;
      case '--max-pages':
        overrides.maxPages = Number(next());
        break;
      case '--max-depth':
        overrides.maxDepth = Number(next());
        break;
      case '--concurrency':
        overrides.concurrency = Number(next());
        break;
      case '--link-concurrency':
        overrides.linkConcurrency = Number(next());
        break;
      case '--per-origin':
        overrides.perOriginConcurrency = Number(next());
        break;
      case '--settle':
        overrides.settleMs = Number(next());
        break;
      case '--delay':
        overrides.delayMs = Number(next());
        break;
      case '--only':
        overrides.checks = next().split(',').map((s) => s.trim());
        break;
      case '--skip':
      case '--disable':
        overrides.disabledChecks = list();
        break;
      case '--paths':
        overrides.includePaths = list();
        break;
      case '--exclude-paths':
        overrides.excludePaths = list();
        break;
      case '--rules':
        overrides.rules = list();
        break;
      case '--priority':
        overrides.priorities = list().map((s) => s.toUpperCase());
        break;
      case '--category':
        overrides.categories = list();
        break;
      case '--list-rules':
        listRules();
        process.exit(0);
        break;
      case '--fail-on':
        overrides.failOn = next() as Severity | 'never';
        break;
      case '--out':
        overrides.outDir = next();
        break;
      case '--name':
        overrides.runName = next();
        break;
      case '--no-sitemap':
        overrides.seedFromSitemap = false;
        break;
      case '--no-llms-txt':
        overrides.seedFromLlmsTxt = false;
        break;
      case '--no-follow':
        overrides.followLinks = false;
        break;
      case '--ignore-robots':
        overrides.respectRobots = false;
        break;
      case '--verbose':
      case '-v':
        overrides.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown flag: ${arg}\n`);
          printHelp();
          process.exit(2);
        }
    }
  }

  // `--only llms-txt` means "check llms.txt and nothing else" — so don't crawl the site.
  // Without this, it would still walk thousands of pages and report nothing about them.
  if (overrides.checks?.length === 1 && overrides.checks[0] === 'llms-txt') {
    overrides.followLinks = false;
    overrides.seedFromSitemap = overrides.seedFromSitemap ?? true;
    overrides.maxPages = overrides.maxPages ?? 1;
  }

  // `--only consent-banner` doesn't read anything from the main crawl — it drives its own
  // browser contexts straight against the locale roots. Without this it would still walk
  // the whole frontier (maxPages defaults to 10,000) just to throw every page away.
  if (overrides.checks?.length === 1 && overrides.checks[0] === 'consent-banner') {
    overrides.followLinks = false;
    overrides.seedFromSitemap = overrides.seedFromSitemap ?? false;
    overrides.seedFromLlmsTxt = overrides.seedFromLlmsTxt ?? false;
    overrides.maxPages = overrides.maxPages ?? 1;
  }

  return overrides;
}

/** Prints every rule the crawler can emit, grouped by priority, so --rules is discoverable. */
function listRules(): void {
  console.log('\nRules the crawler can report, by priority:\n');
  for (const p of PRIORITY_ORDER) {
    const rules = Object.entries(RULE_META).filter(([, m]) => m.priority === p);
    if (rules.length === 0) continue;
    console.log(`${p} — ${PRIORITY_LABEL[p]}`);
    for (const [rule, meta] of rules) {
      console.log(`  ${rule.padEnd(32)} ${CATEGORY_LABEL[meta.category]}`);
    }
    console.log();
  }
  console.log('Categories: ' + Object.keys(CATEGORY_LABEL).join(', ') + '\n');
}

function printHelp(): void {
  console.log(`
sitesnitch — finds what your site is leaking, breaking and getting wrong

Usage: sitesnitch [options]
       (or: npx sitesnitch --url https://example.com)

Reads ${CONFIG_FILES[0]} from the working directory if there is one; flags win.

Options:
  --url <url>            Site to crawl (required, unless set in the config file)
  --forbidden-hosts <a,b> Hosts that must never appear in production, e.g.
                         staging.example.com,*.internal.example.com — this is the
                         check the tool exists for, and only you know your hostnames
  --locales <a,b>        Locale path prefixes to crawl, e.g. en,de (default: all paths)
  --max-pages <n>        Stop after N pages (default: ${DEFAULT_CONFIG.maxPages})
  --max-depth <n>        Max link depth from a seed (default: ${DEFAULT_CONFIG.maxDepth})
  --concurrency <n>      Parallel browser contexts (default: ${DEFAULT_CONFIG.concurrency})
  --link-concurrency <n> Parallel link status probes (default: ${DEFAULT_CONFIG.linkConcurrency})
  --per-origin <n>       Max in-flight requests to one host (default: ${DEFAULT_CONFIG.perOriginConcurrency}) — raising
                         this is what overloads the site under test; read the docs first
  --settle <ms>          Wait for network idle after load (default: ${DEFAULT_CONFIG.settleMs})
  --delay <ms>           Politeness delay between navigations (default: ${DEFAULT_CONFIG.delayMs})
  --paths <a,b>          Crawl ONLY these path prefixes, e.g. --paths /blog
  --exclude-paths <a,b>  Skip these path prefixes
  --only <a,b>           Run only these checks: ${ALL_CHECKS.join(', ')}
                         This is the lever that makes a run CHEAP — e.g. --only
                         forbidden-hosts skips link probing entirely.
  --skip <a,b>           Run everything EXCEPT these checks. Applied last, so it
                         also overrides --only. e.g. --skip accessibility

Report only specific issues (these filter output; the crawl still runs in full):
  --rules <a,b>          Only these rules, e.g. --rules missing-h1,link-dead
  --priority <P0,P1>     Only these priorities
  --category <a,b>       Only these categories: ${Object.keys(CATEGORY_LABEL).join(', ')}
  --list-rules           Print every rule with its priority and category, then exit
  --fail-on <level>      Exit non-zero at: error | warning | never (default: error)
  --out <dir>            Reports root (default: ${DEFAULT_CONFIG.outDir}). One viewer, one dir per run.
  --name <run>           Name this run's subdirectory (default: derived from scope)
  --no-sitemap           Don't seed from sitemap.xml
  --no-llms-txt          Don't seed from or check llms.txt
  --no-follow            Don't follow links (crawl seeds only)
  --ignore-robots        Ignore robots.txt Disallow rules
  -v, --verbose          Log every issue as it's found, not just errors
  --report-only <json>   Re-render reports from a previous run's report.json, no crawling
  -h, --help             Show this help

Examples:
  sitesnitch --url https://example.com                   Full site
  sitesnitch --locales en --max-pages 20                 Quick smoke run
  sitesnitch --only forbidden-hosts                      Hunt staging/dev leaks only (fast)
  sitesnitch --only llms-txt                             Check llms.txt links only
  sitesnitch --skip accessibility,images                 Everything but those two
  sitesnitch --priority P0                               Report only critical issues
  sitesnitch --rules missing-h1,link-dead                Report only these two rules
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
