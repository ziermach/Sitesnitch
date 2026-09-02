import { describe, expect, it } from 'vitest';
import { forbiddenHostsCheck } from '../src/checks/forbiddenHosts.js';
import { httpStatusCheck } from '../src/checks/httpStatus.js';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js';
import type { DomSnapshot, Issue, PageContext } from '../src/types.js';

/**
 * The forbidden-host list ships empty — only the site's owner knows their own internal
 * hostnames — so every test here has to declare the hosts it is hunting.
 */
const deps = {
  config: mergeConfig(DEFAULT_CONFIG, {
    baseUrl: 'https://example.com',
    forbiddenHosts: ['staging.example.com', 'dev.example.com'],
  }),
  linkStatus: () => undefined,
};

const emptyDom = (): DomSnapshot => ({
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
});

const ctx = (overrides: Partial<PageContext> = {}): PageContext => ({
  url: 'https://example.com/en/vps',
  finalUrl: 'https://example.com/en/vps',
  status: 200,
  redirectChain: [],
  depth: 0,
  source: 'test',
  loadMs: 100,
  dom: emptyDom(),
  console: [],
  failedRequests: [],
  requestUrls: [],
  axe: null,
  ...overrides,
});

/**
 * The check exists to catch staging/dev leaks, and a leak arrives through more than one
 * door. Each test below is one door — if any of them regress, the crawler reports a clean
 * site that isn't.
 */
describe('forbiddenHostsCheck', () => {
  it('finds a staging host in a link', () => {
    const dom = emptyDom();
    dom.links = [{ href: 'https://staging.example.com/en/cart', text: 'Buy', rel: null }];

    const issues = forbiddenHostsCheck(ctx({ dom }), deps) as ReturnType<typeof forbiddenHostsCheck> & object[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'forbidden-host-in-link', severity: 'error' });
  });

  it('finds a dev host in an asset', () => {
    const dom = emptyDom();
    dom.resources = [{ url: 'https://dev.example.com/logo.png', where: 'img[src]' }];

    const issues = forbiddenHostsCheck(ctx({ dom }), deps) as object[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'forbidden-host-in-resource', severity: 'error' });
  });

  it('finds a staging host in a canonical tag', () => {
    const dom = emptyDom();
    dom.canonical = 'https://staging.example.com/en/vps';

    const issues = forbiddenHostsCheck(ctx({ dom }), deps) as object[];
    expect(issues[0]).toMatchObject({ rule: 'forbidden-host-in-canonical', severity: 'error' });
  });

  it('finds a host in a request the HTML never shows — the JS-built case', () => {
    const issues = forbiddenHostsCheck(
      ctx({ requestUrls: ['https://dev.example.com/api/price'] }),
      deps,
    ) as object[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'forbidden-host-in-request', where: 'network' });
  });

  it('finds a staging hop in a redirect chain that ends at a healthy 200', () => {
    const issues = forbiddenHostsCheck(
      ctx({ redirectChain: ['https://example.com/old', 'https://staging.example.com/en/vps'] }),
      deps,
    ) as object[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'forbidden-host-in-redirect', severity: 'error' });
  });

  it('finds a host buried in an inline script config blob', () => {
    const dom = emptyDom();
    dom.inlineScripts = ['window.CONFIG={apiBase:"https://staging.example.com/api"};'];

    const issues = forbiddenHostsCheck(ctx({ dom }), deps) as object[];
    expect(issues[0]).toMatchObject({ rule: 'forbidden-host-in-inline-script', severity: 'error' });
  });

  it('collapses the SAME link repeated down a nav', () => {
    const dom = emptyDom();
    // One staging link in a nav that renders on every row of a listing page: one thing to fix.
    dom.links = Array.from({ length: 50 }, () => ({
      href: 'https://staging.example.com/en/cart',
      text: 'Buy',
      rel: null,
    }));

    const issues = forbiddenHostsCheck(ctx({ dom }), deps) as object[];
    expect(issues).toHaveLength(1);
  });

  it('does not report the crawled site as leaking itself when it IS localhost', () => {
    // Pointing the crawler at a dev server or a CI container is normal. Without an
    // exemption for the site's own host, `localhostHosts` matches its origin and every
    // asset and XHR on every page becomes a "localhost leak" — hundreds of false errors on
    // the one check that must never cry wolf.
    const local = {
      config: mergeConfig(DEFAULT_CONFIG, {
        baseUrl: 'http://127.0.0.1:3000',
        forbiddenHosts: ['staging.example.com'],
      }),
      linkStatus: () => undefined,
    };

    const dom = emptyDom();
    dom.resources = [{ url: 'http://127.0.0.1:3000/app.js', where: 'script[src]' }];

    const page = ctx({
      url: 'http://127.0.0.1:3000/',
      finalUrl: 'http://127.0.0.1:3000/',
      dom,
      requestUrls: ['http://127.0.0.1:3000/api/health'],
    });

    expect(forbiddenHostsCheck(page, local)).toEqual([]);
  });

  it('still reports a DIFFERENT localhost port than the one being crawled', () => {
    // The exemption is for the site's own host, not for localhost in general: a page on
    // :3000 loading a script off :8080 is still a machine-local reference that breaks for
    // every visitor.
    const local = {
      config: mergeConfig(DEFAULT_CONFIG, { baseUrl: 'https://example.com' }),
      linkStatus: () => undefined,
    };

    const dom = emptyDom();
    dom.resources = [{ url: 'http://localhost:8080/app.js', where: 'script[src]' }];

    const issues = forbiddenHostsCheck(ctx({ dom }), local) as Issue[];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('forbidden-host-in-resource');
  });

  it('reports DISTINCT leaked URLs separately, even on the same host and surface', () => {
    // Observed for real: one product page shipped 12 distinct staging URLs.
    // Deduping those by host would report "1 leak" and never tell you which URLs to fix —
    // hiding the blast radius of the highest-stakes finding the tool produces.
    const dom = emptyDom();
    dom.links = [
      'https://staging.example.com/de/products/',
      'https://staging.example.com/de/archive/',
      'https://staging.example.com/de/storage-plans/',
      'https://staging.example.com/de/buckets/',
      'https://staging.example.com/de/locations/europe/',
    ].map((href) => ({ href, text: 'Order', rel: null }));

    const issues = forbiddenHostsCheck(ctx({ dom }), deps) as Issue[];
    expect(issues).toHaveLength(5);
    expect(new Set(issues.map((i) => i.target)).size).toBe(5);
  });

  it('a page we could not read is an error, not a clean page', () => {
    // The whole tool rests on "no findings" meaning "no problems". When DOM extraction
    // throws, every DOM-dependent check returns nothing — which is indistinguishable from
    // a clean page unless the failure itself is reported. It must be.
    const issues = httpStatusCheck(
      ctx({ dom: null, domError: 'page.evaluate: ReferenceError: __name is not defined' }),
      deps,
    ) as Issue[];

    expect(issues).toContainEqual(
      expect.objectContaining({ rule: 'dom-extraction-failed', severity: 'error' }),
    );
  });

  it('does not accuse legitimate external sites that merely start with "dev."', () => {
    // A `dev.*` wildcard flagged dev.to and dev.mysql.com — a developer blog and MySQL's
    // own documentation — as leaked internal environments, on a real crawl. A check that
    // cries wolf about MySQL's docs is a check that gets ignored, and this is the one
    // finding in the tool that must never be ignored.
    const dom = emptyDom();
    dom.links = [
      { href: 'https://dev.to/some-author/a-post-about-buckets', text: 'Guide', rel: null },
      { href: 'https://dev.mysql.com/doc/refman/8.0/en/privileges-provided.html', text: 'Docs', rel: null },
      { href: 'https://staging.othervendor.test/some-article', text: 'Article', rel: null },
    ];

    expect(forbiddenHostsCheck(ctx({ dom }), deps)).toEqual([]);
  });

  it('ignores a localhost LINK (tutorial prose) but flags a localhost ASSET (shipped bug)', () => {
    // Same host, opposite meaning, decided by surface. The Ollama tutorial legitimately
    // tells readers to open http://localhost:11434. A stylesheet pointing there does not.
    const prose = emptyDom();
    prose.links = [{ href: 'http://localhost:11434/api/generate', text: 'Ollama API', rel: null }];
    expect(forbiddenHostsCheck(ctx({ dom: prose }), deps)).toEqual([]);

    const asset = emptyDom();
    asset.resources = [{ url: 'http://localhost:3000/app.css', where: 'link[href]' }];
    const issues = forbiddenHostsCheck(ctx({ dom: asset }), deps) as Issue[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error' });
  });

  it('flags a localhost XHR — the runtime surface a tutorial can never explain away', () => {
    const issues = forbiddenHostsCheck(
      ctx({ requestUrls: ['http://127.0.0.1:5000/api/price'] }),
      deps,
    ) as Issue[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ where: 'network', severity: 'error' });
  });

  it('stays silent on a clean production page', () => {
    const dom = emptyDom();
    dom.links = [{ href: 'https://example.com/en/pricing', text: 'Pricing', rel: null }];
    dom.canonical = 'https://example.com/en/vps';
    dom.resources = [{ url: 'https://example.com/logo.svg', where: 'img[src]' }];

    const issues = forbiddenHostsCheck(
      ctx({ dom, requestUrls: ['https://example.com/api/x', 'https://www.google-analytics.com/g'] }),
      deps,
    ) as object[];
    expect(issues).toEqual([]);
  });
});
