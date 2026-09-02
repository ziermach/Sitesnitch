import { describe, expect, it } from 'vitest';
import { parseLlmsTxt } from '../src/llmsTxt.js';
import { parseSitemapLocs, isSitemapIndex } from '../src/sitemap.js';

describe('parseLlmsTxt', () => {
  const doc = `# Example

> Hosting provider.

## VPS

- [Cloud VPS](https://example.com/en/vps/): Virtual servers
- [Storage plans](/en/storage-plans/): Big disks

## Blog

- [How to install n8n](https://example.com/blog/n8n)
Bare link: https://example.com/en/pricing
`;

  it('extracts markdown links with their section', () => {
    const { links } = parseLlmsTxt(doc, 'https://example.com');
    const vps = links.find((l) => l.title === 'Cloud VPS');
    expect(vps).toMatchObject({ section: 'VPS', url: 'https://example.com/en/vps/' });
  });

  it('resolves relative links against the base URL', () => {
    const { links } = parseLlmsTxt(doc, 'https://example.com');
    expect(links.find((l) => l.title === 'Storage plans')?.url).toBe(
      'https://example.com/en/storage-plans/',
    );
  });

  it('picks up bare URLs, not just markdown links', () => {
    const { links } = parseLlmsTxt(doc, 'https://example.com');
    expect(links.some((l) => l.url === 'https://example.com/en/pricing')).toBe(true);
  });

  it('does not double-count a markdown link as a bare URL too', () => {
    const { links } = parseLlmsTxt(doc, 'https://example.com');
    expect(links.filter((l) => l.url === 'https://example.com/en/vps/')).toHaveLength(1);
  });

  it('records line numbers so a report can point at the line to fix', () => {
    const { links } = parseLlmsTxt(doc, 'https://example.com');
    expect(links.find((l) => l.title === 'Cloud VPS')?.line).toBe(7);
  });

  it('treats # as the document title, not a section', () => {
    const { sections } = parseLlmsTxt(doc, 'https://example.com');
    expect(sections).toEqual(['VPS', 'Blog']);
  });
});

describe('sitemap parsing', () => {
  const index = `<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/en/sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.com/de/sitemap.xml</loc></sitemap>
    </sitemapindex>`;

  const urlset = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/en/vps/</loc></url>
      <url><loc>https://example.com/en/s?a=1&amp;b=2</loc></url>
    </urlset>`;

  it('distinguishes an index from a urlset', () => {
    expect(isSitemapIndex(index)).toBe(true);
    expect(isSitemapIndex(urlset)).toBe(false);
  });

  it('extracts and normalizes locs, decoding XML entities', () => {
    expect(parseSitemapLocs(urlset)).toEqual([
      // Slash preserved: the sitemap is the site telling us its canonical form.
      'https://example.com/en/vps/',
      'https://example.com/en/s?a=1&b=2',
    ]);
  });

  it('reads child sitemaps out of an index', () => {
    expect(parseSitemapLocs(index)).toEqual([
      'https://example.com/en/sitemap.xml',
      'https://example.com/de/sitemap.xml',
    ]);
  });
});
