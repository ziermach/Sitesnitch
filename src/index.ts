/**
 * Public API.
 *
 * The shortest useful program is:
 *
 *   import { createCrawler } from 'sitesnitch';
 *
 *   const crawler = createCrawler({
 *     baseUrl: 'https://example.com',
 *     forbiddenHosts: ['staging.example.com', 'dev.example.com'],
 *   });
 *
 *   const { report } = await crawler.run();
 *   console.log(report.counts);
 *
 * Everything below that line is opt-in: writing the HTML/JSON reports, streaming progress,
 * adding your own checks, deriving a CI exit code.
 */

import {
  resolveConfig,
  type CrawlerOptions,
  type ResolvedConfig,
} from './config.js';
import {
  exitCode,
  runCrawl,
  writeReports,
  type CrawlHooks,
  type CrawlOutcome,
  type WrittenReports,
} from './run.js';
import type { CrawlReport } from './types.js';

export interface Crawler {
  /** The configuration this crawler will use, defaults filled in and validated. */
  readonly config: ResolvedConfig;
  /** Crawls the site and returns the report. Writes nothing to disk. */
  run(hooks?: CrawlHooks): Promise<CrawlOutcome>;
  /** Writes report.json and (re)builds the viewer under `outDir`. */
  writeReports(report: CrawlReport): Promise<WrittenReports>;
  /** The exit code a CI job should use for this report, per `failOn`. */
  exitCode(report: CrawlReport): number;
}

/**
 * Builds a crawler for one site.
 *
 * The options are validated here rather than at the first request, so a typo in `baseUrl`
 * or an unknown check id fails immediately instead of an hour into a run.
 */
export function createCrawler(options: CrawlerOptions): Crawler {
  const config = resolveConfig(options);

  return {
    config,
    run: (hooks) => runCrawl(config, hooks),
    writeReports: (report) => writeReports(report, config),
    exitCode: (report) => exitCode(report, config.failOn),
  };
}

// --- configuration -----------------------------------------------------------
export {
  ALL_CHECKS,
  DEFAULT_CONFIG,
  defineConfig,
  mergeConfig,
  resolveConfig,
  type CrawlerConfig,
  type CrawlerOptions,
  type CustomCheck,
  type ResolvedConfig,
} from './config.js';

// --- running -----------------------------------------------------------------
export {
  countBySeverity,
  exitCode,
  runCrawl,
  runNameOf,
  writeReports,
  type CrawlHooks,
  type CrawlOutcome,
  type WrittenReports,
} from './run.js';

// --- triage ------------------------------------------------------------------
export {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RULE_META,
  classify,
  classifyIssue,
  priorityRank,
  registerRules,
  type Category,
  type ClassifiedIssue,
  type Priority,
  type RuleMeta,
} from './classify.js';

// --- reporting ---------------------------------------------------------------
export { printSummary } from './report/console.js';
export { rebuildIndex, writeHtmlReport, type RunSummary } from './report/html.js';
export { writeJsonReport } from './report/json.js';

// --- writing your own checks -------------------------------------------------
export { PAGE_CHECKS, runPageChecks } from './checks/index.js';

export type {
  AxeImpact,
  AxeViolation,
  BuiltinCheckId,
  Check,
  CheckDeps,
  CheckId,
  ConsoleEntry,
  CrawlReport,
  DomSnapshot,
  FailedRequest,
  Issue,
  LinkStatus,
  PageContext,
  PageResult,
  Severity,
} from './types.js';

/**
 * Crawl a site and write its reports, in one call.
 *
 * The convenience path for "I have a URL and I want a report" — everything the CLI does
 * except reading argv and exiting the process. Progress goes to stdout by default; pass
 * `{ log: () => {} }` for silence.
 */
export async function crawl(
  options: CrawlerOptions,
  hooks: CrawlHooks = {},
): Promise<CrawlOutcome & WrittenReports> {
  const outcome = await runCrawl(options, { log: console.log, ...hooks });
  const written = await writeReports(outcome.report, outcome.config);
  return { ...outcome, ...written };
}
