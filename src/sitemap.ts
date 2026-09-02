import { normalizeUrl } from './url.js';

/** Is this a <sitemapindex> (pointing at more sitemaps) rather than a <urlset>? */
export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Pulls every <loc> out of a sitemap or sitemap index. Regex, not a DOM parse — these files are machine-generated and flat. */
export function parseSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const decoded = decodeXmlEntities(raw);
    const normalized = normalizeUrl(decoded);
    if (normalized) locs.push(normalized);
  }
  return locs;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export interface SitemapFetchResult {
  urls: string[];
  /** Sitemap files we successfully read, for reporting. */
  sitemapsRead: string[];
  /** Sitemap files that failed to load, keyed by URL. A broken sitemap is itself a finding. */
  errors: Array<{ url: string; error: string }>;
}

/**
 * Walks a sitemap (or sitemap index) recursively and returns every page URL.
 *
 * `depth` guards against a sitemap index that points at itself — rare, but it would
 * otherwise spin forever.
 */
export async function fetchSitemapUrls(
  entryUrls: string[],
  fetchText: (url: string) => Promise<string>,
  maxDepth = 3,
): Promise<SitemapFetchResult> {
  const urls = new Set<string>();
  const sitemapsRead: string[] = [];
  const errors: Array<{ url: string; error: string }> = [];
  const seen = new Set<string>();

  async function walk(url: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);

    let xml: string;
    try {
      xml = await fetchText(normalized);
    } catch (err) {
      errors.push({ url: normalized, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    sitemapsRead.push(normalized);

    const locs = parseSitemapLocs(xml);
    if (isSitemapIndex(xml)) {
      await Promise.all(locs.map((loc) => walk(loc, depth + 1)));
    } else {
      for (const loc of locs) urls.add(loc);
    }
  }

  await Promise.all(entryUrls.map((u) => walk(u, 0)));

  return { urls: [...urls], sitemapsRead, errors };
}
