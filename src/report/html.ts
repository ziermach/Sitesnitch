import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_LABEL, PRIORITY_LABEL, PRIORITY_ORDER, RULE_META, classify } from '../classify.js';
import type { CrawlReport } from '../types.js';

/** One entry in the index: enough to choose a run without opening its 30 MB of JSON. */
export interface RunSummary {
  /** Directory name under the reports root — also the URL the viewer loads. */
  name: string;
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  pagesCrawled: number;
  linksChecked: number;
  issues: number;
  /** Issue counts per priority. The number people actually steer by. */
  byPriority: Record<string, number>;
}

/**
 * Writes the run's data, and (re)builds the shared viewer at the reports root.
 *
 * There is exactly ONE viewer — `reports/index.html` — and each run is a subdirectory it can
 * load. Previously every run emitted its own copy of the HTML, which meant N copies of the
 * same view drifting apart, and no way to see what runs even existed. Now the crawl of the
 * main site, the blog, and any one-off sweep all sit side by side in one place.
 *
 * `index.json` is a manifest of those runs. It exists so the viewer can list them without
 * downloading each run's report.json (they are tens of megabytes) just to show a date.
 */
export async function writeHtmlReport(_report: unknown, runDir: string): Promise<string> {
  const root = reportsRootOf(runDir);

  await mkdir(root, { recursive: true });
  await copyFile(fileURLToPath(new URL('../../viewer/index.html', import.meta.url)), join(root, 'index.html'));
  await writeFile(join(root, 'classify.js'), renderClassifyModule(), 'utf8');
  await rebuildIndex(root);

  return join(root, 'index.html');
}

/** The run directory is `<root>/<runName>`; the viewer lives one level up. */
function reportsRootOf(runDir: string): string {
  const parent = join(runDir, '..');
  return parent === '.' ? runDir : parent;
}

/**
 * Rescans the reports root and rewrites index.json.
 *
 * Built by reading what is actually on disk rather than by appending to a list, so a run
 * you delete disappears from the index and one you copy in shows up. The index cannot claim
 * a report exists that doesn't.
 */
export async function rebuildIndex(root: string): Promise<RunSummary[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const runs: RunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const jsonPath = join(root, entry.name, 'report.json');
    try {
      const report = JSON.parse(await readFile(jsonPath, 'utf8')) as CrawlReport;
      runs.push(summarize(entry.name, report));
    } catch {
      // Not a report directory, or a run that died before writing. Either way, not a run.
    }
  }

  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  await writeFile(join(root, 'index.json'), JSON.stringify({ runs }, null, 2), 'utf8');
  return runs;
}

function summarize(name: string, report: CrawlReport): RunSummary {
  const issues = [...report.pages.flatMap((p) => p.issues), ...report.globalIssues];

  const byPriority: Record<string, number> = {};
  for (const p of PRIORITY_ORDER) byPriority[p] = 0;
  for (const issue of issues) {
    const { priority } = classify(issue.rule);
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;
  }

  return {
    name,
    baseUrl: report.baseUrl,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    pagesCrawled: report.pagesCrawled,
    linksChecked: report.linksChecked,
    issues: issues.length,
    byPriority,
  };
}

function renderClassifyModule(): string {
  return `// GENERATED from src/classify.ts — do not edit by hand; the crawler rewrites it.
export const RULE_META = ${JSON.stringify(RULE_META, null, 2)};
export const PRIORITY_ORDER = ${JSON.stringify(PRIORITY_ORDER)};
export const PRIORITY_LABEL = ${JSON.stringify(PRIORITY_LABEL, null, 2)};
export const CATEGORY_LABEL = ${JSON.stringify(CATEGORY_LABEL, null, 2)};

const FALLBACK = {
  priority: 'P2',
  category: 'content',
  rationale: 'Unclassified rule — add it to RULE_META in src/classify.ts.',
};

export function classify(rule) {
  return RULE_META[rule] ?? FALLBACK;
}
`;
}
