import { describe, expect, it } from 'vitest';
import { imagesCheck } from '../src/checks/images.js';
import { linksCheck } from '../src/checks/links.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DomSnapshot, Issue, LinkStatus, PageContext } from '../src/types.js';

/**
 * These guard the report's credibility rather than its coverage.
 *
 * The first real crawl produced a "dead link" error next to the Facebook icon on every
 * page (Facebook answers bot HEAD requests with 400) and a "broken image" error for the
 * Bing tracking pixel on every page (it's a 1x1 beacon that never decodes). Neither is a
 * defect, both appear site-wide, and a report where the loudest errors are false is a
 * report nobody reads twice.
 */

const dom = (overrides: Partial<DomSnapshot> = {}): DomSnapshot => ({
  title: 'Example',
  metaDescription: null,
  metaRobots: null,
  canonical: null,
  htmlLang: 'en',
  h1s: ['Example'],
  og: {},
  hreflang: [],
  links: [],
  images: [],
  resources: [],
  inlineScripts: [],
  consentBannerVisible: false,
  ...overrides,
});

const ctx = (d: DomSnapshot): PageContext => ({
  url: 'https://example.com/en/vps/',
  finalUrl: 'https://example.com/en/vps/',
  status: 200,
  redirectChain: [],
  depth: 0,
  source: 'test',
  loadMs: 100,
  dom: d,
  console: [],
  failedRequests: [],
  requestUrls: [],
  axe: null,
});

const status = (url: string, code: number): LinkStatus => ({
  url,
  status: code,
  redirects: 0,
  durationMs: 50,
});

describe('links check separates "gone" from "refused us"', () => {
  const run = (url: string, code: number): Issue[] => {
    const d = dom({ links: [{ href: url, text: 'Facebook', rel: null }] });
    return linksCheck(ctx(d), {
      config: DEFAULT_CONFIG,
      linkStatus: () => status(url, code),
    }) as Issue[];
  };

  it('does not call a bot-blocking social link dead', () => {
    const issues = run('https://www.facebook.com/ExampleCom/', 400);
    expect(issues[0]?.rule).toBe('link-refused');
    expect(issues[0]?.severity).toBe('info');
  });

  it('flags a refusal from an unknown host as a warning worth checking by hand', () => {
    const issues = run('https://docs.example.com/article', 403);
    expect(issues[0]?.rule).toBe('link-refused');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('still calls a real 404 an error', () => {
    const issues = run('https://example.com/en/locations/japan/', 404);
    expect(issues[0]).toMatchObject({ rule: 'link-dead', severity: 'error' });
  });

  it('still calls a 500 an error', () => {
    const issues = run('https://example.com/en/broken/', 503);
    expect(issues[0]).toMatchObject({ rule: 'link-server-error', severity: 'error' });
  });

  it('treats LinkedIn 999 as a refusal, not a server error', () => {
    // 999 is >= 500, so an ordering slip puts it in the server-error branch and the refusal
    // handling below it never runs — for the single host that most needs it. It did exactly
    // that, and filed 24 false errors on a real crawl.
    const issues = run('https://www.linkedin.com/company/example/', 999);
    expect(issues[0]).toMatchObject({ rule: 'link-refused', severity: 'info' });
  });
});

describe('images check ignores tracking beacons', () => {
  const run = (src: string): Issue[] => {
    const d = dom({ images: [{ src, alt: '', naturalWidth: 0 }] });
    return imagesCheck(ctx(d), { config: DEFAULT_CONFIG, linkStatus: () => undefined }) as Issue[];
  };

  it('does not report a bing beacon as a broken image', () => {
    expect(run('https://bat.bing.net/action/0?ti=97057227&evt=pageLoad')).toEqual([]);
  });

  it('still reports a genuinely broken image on our own CDN', () => {
    const issues = run('https://example.com/assets/hero.png');
    expect(issues[0]).toMatchObject({ rule: 'broken-image', severity: 'error' });
  });
});
