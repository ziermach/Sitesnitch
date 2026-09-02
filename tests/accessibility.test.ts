import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessibilityCheck } from '../src/checks/accessibility.js';
import { runPageChecks } from '../src/checks/index.js';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js';
import { Crawler } from '../src/crawler.js';
import { Frontier } from '../src/frontier.js';
import { EMPTY_ROBOTS } from '../src/robots.js';
import type { AxeViolation, Issue, PageContext } from '../src/types.js';

const ctx = (overrides: Partial<PageContext> = {}): PageContext => ({
  url: 'https://example.com/en/vps/',
  finalUrl: 'https://example.com/en/vps/',
  status: 200,
  redirectChain: [],
  depth: 0,
  source: 'test',
  loadMs: 100,
  dom: null,
  console: [],
  failedRequests: [],
  requestUrls: [],
  axe: null,
  ...overrides,
});

const deps = { config: DEFAULT_CONFIG, linkStatus: () => undefined };

const violation = (over: Partial<AxeViolation> = {}): AxeViolation => ({
  id: 'color-contrast',
  impact: 'serious',
  help: 'Elements must meet minimum colour contrast ratio thresholds',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
  tags: ['cat.color', 'wcag2aa', 'wcag143'],
  nodes: ['.hero > p'],
  nodeCount: 1,
  ...over,
});

describe('accessibilityCheck', () => {
  it('maps axe impact onto priority-bearing rules', () => {
    const issues = accessibilityCheck(
      ctx({
        axe: [
          violation({ id: 'button-name', impact: 'critical' }),
          violation({ id: 'color-contrast', impact: 'serious' }),
          violation({ id: 'landmark-one-main', impact: 'moderate' }),
          violation({ id: 'region', impact: 'minor' }),
        ],
      }),
      deps,
    ) as Issue[];

    expect(issues.map((i) => i.rule)).toEqual([
      'a11y-critical',
      'a11y-serious',
      'a11y-moderate',
      'a11y-minor',
    ]);
    // critical/serious block the user outright; moderate/minor are friction.
    expect(issues.map((i) => i.severity)).toEqual(['error', 'error', 'warning', 'warning']);
  });

  it('leads with the axe rule id, so the report is searchable by it', () => {
    const issues = accessibilityCheck(ctx({ axe: [violation({ id: 'aria-required-attr' })] }), deps) as Issue[];
    expect(issues[0]?.message).toMatch(/^aria-required-attr:/);
  });

  it('records the element count and the WCAG criteria', () => {
    const issues = accessibilityCheck(
      ctx({ axe: [violation({ nodeCount: 42, nodes: ['.a', '.b'] })] }),
      deps,
    ) as Issue[];

    expect(issues[0]?.message).toContain('42 elements');
    expect(issues[0]?.detail).toContain('+40 more');
    expect(issues[0]?.detail).toContain('WCAG2AA');
  });

  it('an audit that could not run is an error, not a clean page', () => {
    // Same rule as domError: a check that silently produced nothing looks exactly like a
    // page with no problems. Accessibility is the easiest place for that lie to hide.
    const issues = accessibilityCheck(ctx({ axeError: 'axe is not defined' }), deps) as Issue[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'a11y-audit-failed', severity: 'error' });
  });

  it('says nothing about a page with no violations', () => {
    expect(accessibilityCheck(ctx({ axe: [] }), deps)).toEqual([]);
  });
});

/**
 * axe cannot be audited from HTML source — contrast needs computed styles, ARIA state needs
 * the script that sets it to have run. So the only test that proves this check works is one
 * that drives the real crawler at a real page in a real browser.
 */
describe('accessibility, end to end through the real crawler', () => {
  let server: Server;
  let url: string;

  const BROKEN = `<!doctype html><html lang="en"><head><title>Inaccessible fixture page</title></head>
    <body>
      <h1>Fixture</h1>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <button></button>
      <p style="color:#bbb;background:#fff">Text at a contrast ratio no one can read</p>
      <input type="text">
    </body></html>`;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BROKEN);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no port');
    url = `http://127.0.0.1:${addr.port}/`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('actually finds the violations axe should find', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      baseUrl: url,
      locales: [],
      excludePaths: [],
      concurrency: 1,
      delayMs: 0,
      followLinks: false,
      respectRobots: false,
      checks: ['accessibility'],
    });

    const frontier = new Frontier(config, EMPTY_ROBOTS);
    frontier.add(url, 0, undefined, 'test');

    const seen: PageContext[] = [];
    await new Crawler(config, frontier).run({ onPage: (c) => void seen.push(c) });

    const page = seen[0];
    if (!page) throw new Error('crawler visited no pages');

    // axe ran at all — the failure mode that would otherwise look like a clean page.
    expect(page.axeError).toBeUndefined();
    expect(page.axe).not.toBeNull();

    const issues = await runPageChecks(page, config.checks, {
      config,
      linkStatus: () => undefined,
    });

    const found = issues.map((i) => i.message).join(' | ');

    // The image has no alt, the button has no accessible name, and the input has no label —
    // all invisible to a source-only checker in the general case, and all real barriers.
    expect(found).toMatch(/image-alt|button-name|label/);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.check === 'accessibility')).toBe(true);
  }, 90_000);
});
