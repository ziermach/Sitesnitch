import {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  classifyIssue,
  priorityRank,
  type ClassifiedIssue,
} from '../classify.js';
import type { CrawlReport, Issue, Severity } from '../types.js';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
} as const;

const SEVERITY_COLOR: Record<Severity, string> = {
  error: COLORS.red,
  warning: COLORS.yellow,
  info: COLORS.blue,
};

export function printSummary(report: CrawlReport): void {
  const all = allIssues(report);

  line();
  line(`${COLORS.bold}Crawl summary${COLORS.reset}  ${report.baseUrl}`);
  line(
    `${COLORS.dim}${report.pagesCrawled} pages, ${report.linksChecked} unique links checked, ${(report.durationMs / 1000).toFixed(1)}s${COLORS.reset}`,
  );
  line();

  const { error, warning, info } = report.counts;
  line(
    `  ${SEVERITY_COLOR.error}${error} errors${COLORS.reset}   ` +
      `${SEVERITY_COLOR.warning}${warning} warnings${COLORS.reset}   ` +
      `${SEVERITY_COLOR.info}${info} info${COLORS.reset}`,
  );
  line();

  if (all.length === 0) {
    line(`  ${COLORS.green}No issues found.${COLORS.reset}`);
    line();
    return;
  }

  // Priority first: severity says how sure we are, priority says what to fix. Sorting by
  // severity alone buries a staging link on the pricing page under 670 missing <h1>s.
  const classified = all.map(classifyIssue);

  line(`${COLORS.bold}By priority${COLORS.reset}`);
  for (const p of PRIORITY_ORDER) {
    const n = classified.filter((i) => i.priority === p).length;
    if (n === 0) continue;
    const color = p === 'P0' ? COLORS.red : p === 'P1' ? COLORS.yellow : COLORS.dim;
    line(`  ${color}${p}${COLORS.reset}  ${String(n).padStart(6)}  ${COLORS.dim}${PRIORITY_LABEL[p]}${COLORS.reset}`);
  }
  line();

  // Grouped by rule: 400 identical "missing alt" issues are one line of signal, not 400.
  const byRule = new Map<string, ClassifiedIssue[]>();
  for (const issue of classified) {
    const list = byRule.get(issue.rule) ?? [];
    list.push(issue);
    byRule.set(issue.rule, list);
  }

  const ranked = [...byRule.entries()].sort((a, b) => {
    const p = priorityRank(a[1][0]!.priority) - priorityRank(b[1][0]!.priority);
    return p !== 0 ? p : b[1].length - a[1].length;
  });

  line(`${COLORS.bold}Issues by rule${COLORS.reset}`);
  for (const [rule, issues] of ranked) {
    const first = issues[0]!;
    const color = SEVERITY_COLOR[first.severity];
    const count = String(issues.length).padStart(6);
    line(
      `  ${first.priority}  ${color}${count}${COLORS.reset}  ${rule.padEnd(32)} ` +
        `${COLORS.dim}${CATEGORY_LABEL[first.category]}${COLORS.reset}`,
    );
  }
  line();

  // The staging/dev leak is the reason this tool exists. If any turned up, they get
  // printed in full rather than collapsed into a count — a count is easy to scroll past.
  const forbidden = all.filter((i) => i.check === 'forbidden-hosts');
  if (forbidden.length > 0) {
    line(`${COLORS.red}${COLORS.bold}Forbidden host references (${forbidden.length})${COLORS.reset}`);
    for (const issue of forbidden.slice(0, 25)) {
      line(`  ${COLORS.red}${issue.target}${COLORS.reset}`);
      line(`    ${COLORS.dim}on ${issue.pageUrl} (${issue.where})${COLORS.reset}`);
    }
    if (forbidden.length > 25) {
      line(`  ${COLORS.dim}… and ${forbidden.length - 25} more — see the report${COLORS.reset}`);
    }
    line();
  }

  const errors = all.filter((i) => i.severity === 'error' && i.check !== 'forbidden-hosts');
  if (errors.length > 0) {
    line(`${COLORS.bold}Top errors${COLORS.reset}`);
    for (const issue of errors.slice(0, 15)) {
      line(`  ${COLORS.red}✗${COLORS.reset} ${issue.message}`);
      line(`    ${COLORS.dim}${issue.pageUrl}${issue.target ? ` -> ${issue.target}` : ''}${COLORS.reset}`);
    }
    if (errors.length > 15) {
      line(`  ${COLORS.dim}… and ${errors.length - 15} more${COLORS.reset}`);
    }
    line();
  }
}

export function allIssues(report: CrawlReport): Issue[] {
  return [...report.pages.flatMap((p) => p.issues), ...report.globalIssues];
}

function line(text = ''): void {
  console.log(text);
}
