import { describe, expect, it } from 'vitest';

import { runPageChecks } from '../src/checks/index.js';
import { classify } from '../src/classify.js';
import { resolveConfig, type CustomCheck } from '../src/config.js';
import { createCrawler } from '../src/index.js';
import type { DomSnapshot, PageContext } from '../src/types.js';

const emptyDom = (): DomSnapshot => ({
  title: 'Pricing — Example',
  metaDescription: 'What the plans cost, with no surprises at the end of the month.',
  metaRobots: null,
  canonical: null,
  htmlLang: 'en',
  h1s: ['Pricing'],
  og: {},
  hreflang: [],
  links: [],
  images: [],
  resources: [],
  inlineScripts: [],
  consentBannerVisible: false,
});

const ctx = (): PageContext => ({
  url: 'https://example.com/en/pricing',
  finalUrl: 'https://example.com/en/pricing',
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
});

/**
 * The library surface is a contract with people who cannot read this repo. These tests are
 * about the shape they see: what is required, what is rejected, and whether a check they
 * wrote themselves actually runs.
 */
describe('resolveConfig', () => {
  it('fills in the defaults around the one required option', () => {
    const config = resolveConfig({ baseUrl: 'https://example.com' });
    expect(config.baseUrl).toBe('https://example.com');
    expect(config.concurrency).toBeGreaterThan(0);
    expect(config.checks).toContain('forbidden-hosts');
  });

  it('refuses a config with no site to crawl', () => {
    expect(() => resolveConfig({ baseUrl: '' })).toThrow(/baseUrl is required/);
  });

  it('refuses a baseUrl that is not an absolute http(s) URL', () => {
    // The failure mode this prevents: a bare hostname resolving against nothing, and the
    // crawl dying an hour in rather than at the call site.
    expect(() => resolveConfig({ baseUrl: 'example.com' })).toThrow(/not a valid absolute URL/);
    expect(() => resolveConfig({ baseUrl: 'ftp://example.com' })).toThrow(/must be http/);
  });

  it('refuses an unknown check id rather than silently running fewer checks', () => {
    expect(() =>
      resolveConfig({ baseUrl: 'https://example.com', checks: ['forbiden-hosts'] }),
    ).toThrow(/Unknown check/);
  });

  it('merges nested seo thresholds instead of replacing them wholesale', () => {
    const config = resolveConfig({ baseUrl: 'https://example.com', seo: { titleMax: 60 } as never });
    expect(config.seo.titleMax).toBe(60);
    expect(config.seo.titleMin).toBeGreaterThan(0);
  });
});

describe('custom checks', () => {
  const priceCheck: CustomCheck = {
    id: 'pricing-page',
    check: (page) => {
      if (!page.url.includes('/pricing')) return [];
      return [
        {
          check: 'pricing-page',
          severity: 'error',
          rule: 'pricing-page-missing-price',
          message: 'A pricing page with no price on it',
          pageUrl: page.url,
        },
      ];
    },
    rules: {
      'pricing-page-missing-price': {
        priority: 'P1',
        category: 'content',
        rationale: 'The page exists to state a price and does not.',
      },
    },
  };

  it('runs a check the caller registered', async () => {
    const config = resolveConfig({ baseUrl: 'https://example.com', customChecks: [priceCheck] });
    const issues = await runPageChecks(ctx(), config.checks, {
      config,
      linkStatus: () => undefined,
    });
    expect(issues.map((i) => i.rule)).toContain('pricing-page-missing-price');
  });

  it('adds the custom id to the enabled checks so registering is enough to run it', () => {
    const config = resolveConfig({ baseUrl: 'https://example.com', customChecks: [priceCheck] });
    expect(config.checks).toContain('pricing-page');
  });

  it('respects an explicit checks list — that is the caller saying "only these"', () => {
    // Otherwise --only forbidden-hosts would quietly also run every custom check, and the
    // one flag that makes a run cheap would stop making it cheap.
    const config = resolveConfig({
      baseUrl: 'https://example.com',
      customChecks: [priceCheck],
      checks: ['forbidden-hosts'],
    });
    expect(config.checks).toEqual(['forbidden-hosts']);
  });

  it('registers the custom rule so its findings are ranked, not dumped at the default', () => {
    resolveConfig({ baseUrl: 'https://example.com', customChecks: [priceCheck] });
    expect(classify('pricing-page-missing-price')).toMatchObject({ priority: 'P1' });
  });

  it('refuses to let a custom check shadow a builtin one', () => {
    // A silent substitution here would leave the report naming a check that never ran.
    expect(() =>
      resolveConfig({
        baseUrl: 'https://example.com',
        customChecks: [{ id: 'seo', check: () => [] }],
      }),
    ).toThrow(/collides with a builtin/);
  });
});

describe('createCrawler', () => {
  it('validates at construction, not an hour into the crawl', () => {
    expect(() => createCrawler({ baseUrl: 'nonsense' })).toThrow();
  });

  it('derives the CI exit code from the configured failOn', () => {
    const report = {
      counts: { error: 1, warning: 0, info: 0 },
    } as Parameters<ReturnType<typeof createCrawler>['exitCode']>[0];

    expect(createCrawler({ baseUrl: 'https://example.com' }).exitCode(report)).toBe(1);
    expect(
      createCrawler({ baseUrl: 'https://example.com', failOn: 'never' }).exitCode(report),
    ).toBe(0);
  });
});
