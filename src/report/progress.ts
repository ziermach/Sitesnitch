import type { Issue, PageContext, Severity } from '../types.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
} as const;

/**
 * Live per-page logging.
 *
 * A progress counter that only ticks a number tells you the process is alive, but not that
 * it is doing anything useful — and this crawler has already shipped two bugs (a null DOM,
 * a socket leak) that a counter would happily have counted its way through. So each line
 * carries evidence of real work: the status we got back, how long the page took, how many
 * links we read off it, and what we found wrong. If those columns are empty or identical
 * on every row, something is broken, and you can see that from across the room.
 */
export class ProgressLogger {
  private done = 0;
  private readonly startedAt = Date.now();
  private readonly counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };

  constructor(
    private readonly total: () => number,
    private readonly linksChecked: () => number,
    private readonly verbose: boolean,
    /**
     * Where the lines go. Defaults to stdout for the CLI; a library consumer passes their
     * own sink (or none) rather than having the crawler write to their process's output.
     */
    private readonly log: (line: string) => void = console.log,
  ) {}

  page(ctx: PageContext, issues: Issue[]): void {
    this.done++;
    for (const issue of issues) this.counts[issue.severity]++;

    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;

    const statusColor =
      ctx.status >= 400 || ctx.navigationError ? C.red : ctx.status >= 300 ? C.yellow : C.green;
    const status = ctx.navigationError ? 'ERR' : String(ctx.status);

    const linkCount = ctx.dom?.links.length ?? 0;
    // A page that rendered but exposed no DOM is the silent-failure signature. Call it out
    // on its own line rather than letting it look like a normal 200.
    const domNote = ctx.domError ? `${C.red}NO-DOM${C.reset}` : `${C.grey}${linkCount} links${C.reset}`;

    const flags = [
      errors > 0 ? `${C.red}${errors}E${C.reset}` : '',
      warnings > 0 ? `${C.yellow}${warnings}W${C.reset}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const n = String(this.done).padStart(5);
    const queued = String(this.total()).padStart(5);
    const ms = `${String(ctx.loadMs).padStart(5)}ms`;

    this.log(
      `${C.dim}[${n}/${queued}q]${C.reset} ${statusColor}${status.padEnd(3)}${C.reset} ${ms} ` +
        `${domNote.padEnd(22)} ${flags.padEnd(16)} ${C.cyan}${short(ctx.url)}${C.reset}`,
    );

    // The findings themselves, inline, as they are discovered. A staging-host leak should
    // not have to wait for the final report to be seen.
    if (this.verbose || errors > 0) {
      for (const issue of issues.filter((i) => i.severity === 'error')) {
        const marker = issue.check === 'forbidden-hosts' ? `${C.red}LEAK${C.reset}` : `${C.red}✗${C.reset}`;
        this.log(
          `        ${marker} ${issue.message}${issue.target ? ` ${C.grey}→ ${short(issue.target)}${C.reset}` : ''}`,
        );
      }
    }
  }

  /** Periodic heartbeat, so a stall is visible even when no page has completed. */
  heartbeat(queued: number): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.done / (elapsed / 60);
    const eta = rate > 0 ? Math.round(queued / rate) : 0;

    this.log(
      `${C.dim}────${C.reset} ${this.done} crawled · ${queued} queued · ` +
        `${this.linksChecked()} links probed · ${Math.round(rate)} pages/min · ` +
        `${C.red}${this.counts.error}E${C.reset} ${C.yellow}${this.counts.warning}W${C.reset} · ` +
        `ETA ~${eta}m ${C.dim}────${C.reset}`,
    );
  }
}

function short(url: string): string {
  return url.length > 78 ? url.slice(0, 75) + '…' : url;
}
