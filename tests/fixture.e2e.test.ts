import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPageChecks } from '../src/checks/index.js';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js';
import { Crawler } from '../src/crawler.js';
import { Frontier } from '../src/frontier.js';
import { EMPTY_ROBOTS } from '../src/robots.js';
import type { Issue, PageContext } from '../src/types.js';

/**
 * The check that matters most is the one that reports "nothing found" on a healthy site —
 * which is indistinguishable from a check that is silently broken. So: serve a page that
 * leaks staging/dev hosts through every surface we claim to watch, drive the real crawler
 * at it, and assert we catch all of them.
 *
 * This drives the actual Crawler class rather than a hand-rolled copy of its page-visit
 * logic. An earlier version of this test duplicated that logic, and consequently passed
 * while the real crawler was returning a null DOM on every page and finding nothing.
 */
describe('forbidden-host detection, end to end through the real crawler', () => {
  let leakyServer: Server;
  let cleanServer: Server;
  let leakyUrl: string;
  let cleanUrl: string;

  beforeAll(async () => {
    const leaky = await readFile(
      fileURLToPath(new URL('./fixtures/leaky.html', import.meta.url)),
      'utf8',
    );

    leakyServer = await serve(leaky);
    cleanServer = await serve(
      '<!doctype html><html lang="en"><head><title>A clean page with a long enough title</title>' +
        '<meta name="description" content="A page with no leaks at all, used to prove the checks are not firing unconditionally on every page.">' +
        '</head><body><h1>Clean</h1><a href="https://example.com/en/vps/">VPS</a></body></html>',
    );

    leakyUrl = urlOf(leakyServer);
    cleanUrl = urlOf(cleanServer);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([close(leakyServer), close(cleanServer)]);
  });

  it('catches the leak on every surface: link, asset, canonical, inline script, and network', async () => {
    const issues = await crawlOne(leakyUrl);
    const rules = new Set(issues.filter((i) => i.check === 'forbidden-hosts').map((i) => i.rule));

    expect(rules).toContain('forbidden-host-in-link'); // <a href>
    expect(rules).toContain('forbidden-host-in-resource'); // <img src>
    expect(rules).toContain('forbidden-host-in-canonical'); // <link rel=canonical>
    expect(rules).toContain('forbidden-host-in-inline-script'); // window.APP_CONFIG blob
    expect(rules).toContain('forbidden-host-in-request'); // fetch() — invisible in the HTML

    const forbidden = issues.filter((i) => i.check === 'forbidden-hosts');
    expect(forbidden.every((i) => i.severity === 'error')).toBe(true);
  }, 60_000);

  it('reports no leak on a clean page', async () => {
    const issues = await crawlOne(cleanUrl);
    expect(issues.filter((i) => i.check === 'forbidden-hosts')).toEqual([]);
  }, 60_000);

  it('actually extracts the DOM — a null snapshot would silently disable half the checks', async () => {
    // Guards the __name/esbuild class of bug: if page.evaluate throws, dom comes back null,
    // every DOM-dependent check quietly returns nothing, and the crawler calls the site
    // clean. Assert on real extracted content, not just on the absence of issues.
    const ctx = await crawlOneContext(cleanUrl);

    expect(ctx.dom).not.toBeNull();
    expect(ctx.dom?.title).toBe('A clean page with a long enough title');
    expect(ctx.dom?.h1s).toEqual(['Clean']);
    expect(ctx.dom?.links.map((l) => l.href)).toContain('https://example.com/en/vps/');
    expect(ctx.dom?.metaDescription).toContain('no leaks');
  }, 60_000);
});

/** Runs the real crawler over exactly one URL and returns the issues its checks produced. */
async function crawlOne(url: string): Promise<Issue[]> {
  const config = crawlConfig(url);
  const ctx = await crawlOneContext(url);
  return runPageChecks(ctx, config.checks, { config, linkStatus: () => undefined });
}

async function crawlOneContext(url: string): Promise<PageContext> {
  const config = crawlConfig(url);
  const frontier = new Frontier(config, EMPTY_ROBOTS);
  frontier.add(url, 0);

  const seen: PageContext[] = [];
  await new Crawler(config, frontier).run({ onPage: (ctx) => void seen.push(ctx) });

  const ctx = seen[0];
  if (!ctx) throw new Error('crawler visited no pages');
  return ctx;
}

function crawlConfig(url: string) {
  return mergeConfig(DEFAULT_CONFIG, {
    baseUrl: url,
    locales: [],
    concurrency: 1,
    delayMs: 0,
    followLinks: false,
    respectRobots: false,
    // The fixture is served from 127.0.0.1, which is itself a flagged local address — every
    // asset and request it makes is same-origin. Narrow both lists to the staging hosts this
    // test is actually about, or the fixture's own origin drowns the result.
    forbiddenHosts: ['staging.example.com', 'dev.example.com'],
    localhostHosts: [],
    checks: ['forbidden-hosts', 'seo', 'http-status'],
  });
}

async function serve(html: string): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function urlOf(server: Server): string {
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('server has no port');
  return `http://127.0.0.1:${address.port}/`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
