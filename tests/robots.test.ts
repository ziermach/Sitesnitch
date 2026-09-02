import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../src/robots.js';

/** A realistic robots.txt: a wildcard group, a named bot, and two sitemaps. */
const SAMPLE_ROBOTS = `
User-agent: *
Disallow: /es/es/*
Disallow: /en/clearance/*
Disallow: /de/products/ds-*
Disallow: *-c/*
Disallow: */preview-2026/*

User-agent: BadBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/blog/sitemap_index.xml
`;

describe('parseRobots', () => {
  it('reads the wildcard group and the sitemaps', () => {
    const rules = parseRobots(SAMPLE_ROBOTS);
    expect(rules.disallow).toContain('/en/clearance/*');
    expect(rules.disallow).toContain('*/preview-2026/*');
    expect(rules.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/blog/sitemap_index.xml',
    ]);
  });

  it('ignores rules aimed at other bots', () => {
    // BadBot is disallowed from everything. If we leaked its group into ours, we would
    // crawl nothing at all and report a perfectly clean site.
    const rules = parseRobots(SAMPLE_ROBOTS);
    expect(rules.disallow).not.toContain('/');
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# a comment\nUser-agent: *\nDisallow: /x # trailing\n');
    expect(rules.disallow).toEqual(['/x']);
  });

  it('treats an empty Disallow as no rule', () => {
    expect(parseRobots('User-agent: *\nDisallow:').disallow).toEqual([]);
  });

  it('applies one rule block to consecutive user-agent lines', () => {
    const rules = parseRobots('User-agent: Foo\nUser-agent: *\nDisallow: /shared');
    expect(rules.disallow).toEqual(['/shared']);
  });
});

describe('isAllowed', () => {
  const rules = parseRobots(SAMPLE_ROBOTS);

  it('blocks the disallowed paths', () => {
    expect(isAllowed('https://example.com/en/clearance/deal', rules)).toBe(false);
    expect(isAllowed('https://example.com/de/products/ds-1', rules)).toBe(false);
    expect(isAllowed('https://example.com/en/preview-2026/x', rules)).toBe(false);
  });

  it('allows everything else', () => {
    expect(isAllowed('https://example.com/en/vps', rules)).toBe(true);
    expect(isAllowed('https://example.com/', rules)).toBe(true);
    expect(isAllowed('https://example.com/de/products', rules)).toBe(true);
  });

  it('lets a more specific Allow override a broad Disallow', () => {
    const carved = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public-page');
    expect(isAllowed('https://example.com/private/secret', carved)).toBe(false);
    expect(isAllowed('https://example.com/private/public-page', carved)).toBe(true);
  });
});
