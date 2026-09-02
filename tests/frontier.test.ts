import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig, type CrawlerConfig } from '../src/config.js';
import { Frontier } from '../src/frontier.js';
import { EMPTY_ROBOTS, parseRobots } from '../src/robots.js';

/**
 * A site to test scoping against. The shipped defaults deliberately have no baseUrl, no
 * locales and no excluded paths — nothing can be guessed for a stranger's site — so the
 * scoping rules need a configured site before they have anything to be tested on.
 */
const SITE: Partial<CrawlerConfig> = {
  baseUrl: 'https://example.com',
  locales: ['en', 'es', 'de', 'en-us'],
  excludePaths: ['/blog'],
};

const frontier = (overrides: Partial<CrawlerConfig> = {}, robots = EMPTY_ROBOTS): Frontier =>
  new Frontier(mergeConfig(DEFAULT_CONFIG, { ...SITE, ...overrides }), robots);

describe('Frontier', () => {
  it('accepts an in-scope page', () => {
    const f = frontier();
    expect(f.add('https://example.com/en/vps', 0)).toBeNull();
    expect(f.size).toBe(1);
  });

  it('treats the two trailing-slash forms as one page', () => {
    // The bug this guards: without slash-insensitive identity we crawl the whole site twice.
    const f = frontier();
    expect(f.add('https://example.com/en/vps/', 0)).toBeNull();
    expect(f.add('https://example.com/en/vps', 0)).toBe('duplicate');
    expect(f.size).toBe(1);
  });

  it('queues the URL exactly as authored, slash included', () => {
    const f = frontier();
    f.add('https://example.com/en/vps/', 0);
    expect(f.next()?.url).toBe('https://example.com/en/vps/');
  });

  it('rejects other hosts — including the staging host we are hunting', () => {
    const f = frontier();
    expect(f.add('https://staging.example.com/en/cart', 0)).toBe('off-site');
    expect(f.add('https://other-site.test/', 0)).toBe('off-site');
  });

  it('rejects locales it was not asked to crawl', () => {
    const f = frontier({ locales: ['en'] });
    expect(f.add('https://example.com/en/vps', 0)).toBeNull();
    expect(f.add('https://example.com/de/vps', 0)).toBe('wrong-locale');
  });

  it('still crawls locale-less paths when filtering by locale', () => {
    // The root and other locale-agnostic paths carry no locale prefix and must not be
    // filtered out. (/blog is locale-less too, but it's excluded on its own grounds.)
    const f = frontier({ locales: ['en'] });
    expect(f.add('https://example.com/', 0)).toBeNull();
    expect(f.add('https://example.com/legal/privacy', 0)).toBeNull();
  });

  it('obeys robots.txt, and can be told not to', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /en/clearance/*');
    expect(frontier({}, robots).add('https://example.com/en/clearance/x', 0)).toBe('robots');
    expect(
      frontier({ respectRobots: false }, robots).add('https://example.com/en/clearance/x', 0),
    ).toBeNull();
  });

  it('enforces the depth and page caps', () => {
    expect(frontier({ maxDepth: 2 }).add('https://example.com/a', 3)).toBe('too-deep');

    const f = frontier({ maxPages: 1 });
    expect(f.add('https://example.com/a', 0)).toBeNull();
    expect(f.add('https://example.com/b', 0)).toBe('max-pages');
  });

  it('excludes /blog by default — it is a separate project', () => {
    const f = frontier();
    expect(f.add('https://example.com/blog/what-is-nginx/', 0)).toBe('out-of-scope-path');
    expect(f.add('https://example.com/en/vps/', 0)).toBeNull();
  });

  it('recognises the blog under every locale shape it is served in', () => {
    // /blog/x, /en/blog/x and /blog/de/x are all the same separate project. A naive
    // pathname prefix test catches only the first and quietly crawls the rest.
    const f = frontier();
    expect(f.add('https://example.com/blog/de/was-ist-ollama/', 0)).toBe('out-of-scope-path');
    expect(f.add('https://example.com/en/blog/some-post/', 0)).toBe('out-of-scope-path');
    expect(f.add('https://example.com/blog/kb/103000283038-s3/', 0)).toBe('out-of-scope-path');
  });

  it('--paths scopes a run to one project, blog included', () => {
    const f = frontier({ includePaths: ['/blog'] });
    expect(f.add('https://example.com/blog/what-is-nginx/', 0)).toBeNull();
    // includePaths is an allow-list: the marketing site is now the thing out of scope.
    expect(f.add('https://example.com/en/vps/', 0)).toBe('out-of-scope-path');
  });

  it('--include-blog puts it back', () => {
    const f = frontier({ excludePaths: [] });
    expect(f.add('https://example.com/blog/what-is-nginx/', 0)).toBeNull();
  });

  it('remembers which page a URL was found on', () => {
    // "…?addons=17&addons=1073 returns 500" is half a bug report; the page shipping that
    // href is the half you can actually fix.
    const f = frontier();
    f.add('/en/products/widget-24-pack/?addons=17', 1, 'https://example.com/en/products/');
    expect(f.next()?.source).toBe('https://example.com/en/products/');
  });

  it('labels seeds by where they came from', () => {
    const f = frontier();
    f.add('https://example.com/en/vps/', 0, undefined, 'sitemap');
    expect(f.next()?.source).toBe('sitemap');
  });

  it('counts what it skipped rather than dropping it silently', () => {
    const f = frontier({ locales: ['en'] });
    f.add('https://example.com/de/vps', 0);
    f.add('https://other-site.test/', 0);
    expect(f.skipCounts).toMatchObject({ 'wrong-locale': 1, 'off-site': 1 });
  });
});
