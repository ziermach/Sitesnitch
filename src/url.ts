/** Query params that identify a campaign, not a resource. Stripped during normalization. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
  /^ref$/i,
  /^referrer$/i,
];

/**
 * Canonical form of a URL. Fragments and tracking params never change which page you
 * get, so they go.
 *
 * The trailing slash is deliberately preserved. Many sites serve their canonical URLs with
 * one and 301 the slashless form, so stripping it here would make every single URL on
 * such a site appear to redirect — hundreds of false "this link redirects" warnings, and a
 * wasted extra request per URL. Whether a link has a trailing slash is the site's
 * business, not ours; we fetch exactly what was authored. Use dedupeKey() when you need
 * the two forms to collapse.
 *
 * Returns null for anything we can't or shouldn't crawl (mailto:, javascript:, garbage).
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();

  // Default ports are noise.
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  return u.toString();
}

/**
 * Slash-insensitive identity of a URL, for "have we seen this page already?".
 *
 * `/en/vps` and `/en/vps/` are the same page, so the frontier must not crawl both — but
 * the *link checker* must still fetch each exactly as authored, because only one of them
 * is the canonical form and the other one's redirect is a real (if minor) finding. Hence
 * two functions: normalizeUrl() for fetching, dedupeKey() for identity.
 */
export function dedupeKey(url: string): string | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const u = new URL(normalized);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.toString();
}

/** Same registrable host, ignoring 'www.'. */
export function isSameSite(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return stripWww(a.hostname) === stripWww(b.hostname);
  } catch {
    return false;
  }
}

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Matches a host against a glob pattern. `*` stands for any run of characters, including
 * dots, and may appear anywhere and more than once:
 *
 *   'dev.example.com'      -> exact
 *   '*.local'              -> any subdomain of .local, and 'local' itself
 *   'staging.*'            -> any host whose first label is 'staging', and bare 'staging'
 *   'staging-*'            -> 'staging-01', 'staging-eu.example.com'
 *   '*-staging.example.com'-> 'eu-staging.example.com'
 *   '*.example.*'          -> the same site across every TLD you own
 *   'a.*.example.com'      -> a wildcard in the middle
 *
 * The pattern is anchored at both ends, which is the whole reason this is a glob and not a
 * substring search: `staging.*` matches `staging.example.com` but NOT
 * `not-staging.example.com`, and that distinction is what stops the forbidden-host check
 * from accusing production hosts like `my-staging-tips.example.com`. If you want the loose
 * behaviour, you have to ask for it explicitly with `*staging*` — and you should think
 * hard before you do.
 *
 * The two anchored forms also match the bare host, because `*.local` meaning "a subdomain
 * of .local but not .local itself" would be a surprise, and because the wildcard there
 * stands for "any labels, or none".
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();

  if (!p.includes('*')) return h === p;

  if (p.startsWith('*.') && h === p.slice(2)) return true;
  if (p.endsWith('.*') && h === p.slice(0, -2)) return true;

  return globRegExp(p).test(h);
}

/**
 * Compiled host globs, cached by pattern.
 *
 * hostMatches runs for every candidate URL against every configured pattern — on a big
 * crawl that is millions of calls over a handful of patterns, so recompiling the regex each
 * time is pure waste. The key space is bounded by the config, not by the crawl.
 */
const globCache = new Map<string, RegExp>();

function globRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  // Escape everything that is regex-special, then reinstate `*` as `.*`. Splitting on the
  // wildcard first is what makes that safe: the escaper never sees a `*` it should keep.
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const re = new RegExp(`^${source}$`);
  globCache.set(pattern, re);
  return re;
}

/** First forbidden pattern this URL's host matches, or null. */
export function matchForbiddenHost(url: string, patterns: string[]): string | null {
  const host = hostOf(url);
  if (!host) return null;
  return patterns.find((p) => hostMatches(host, p)) ?? null;
}

/** Locale prefix of a path, e.g. '/en/vps' -> 'en'. Null when there is none. */
export function localeOf(url: string, locales: string[]): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (first && locales.includes(first)) return first;
    return null;
  } catch {
    return null;
  }
}

/**
 * Does this URL belong to one of the given hosts (or a subdomain of one)?
 *
 * Used for the tracking/bot-hostile host lists, where entries are plain hosts and we want
 * `px.ads.linkedin.com` to match a `linkedin.com` entry. A couple of entries carry a path
 * ('facebook.com/tr'), so we fall back to a substring test for those.
 */
export function urlBelongsTo(url: string, hosts: string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;

  return hosts.some((entry) => {
    if (entry.includes('/')) return url.toLowerCase().includes(entry.toLowerCase());
    const h = entry.toLowerCase();
    return host === h || host.endsWith('.' + h);
  });
}

/**
 * Is this URL inside one of the given path prefixes?
 *
 * Locale-insensitive: '/blog' matches /blog/x, /en/blog/x and /blog/de/x. The blog is a
 * separate project whose URLs appear under several locale shapes, and a prefix test that
 * only looked at the raw pathname would silently miss half of them.
 */
export function pathMatches(url: string, prefixes: string[], locales: string[]): boolean {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return false;
  }

  // Drop a leading locale segment so '/en/blog/x' is judged the same as '/blog/x'.
  if (segments[0] && locales.includes(segments[0])) segments = segments.slice(1);
  const path = '/' + segments.join('/');

  return prefixes.some((raw) => {
    const prefix = ('/' + raw.replace(/^\/+|\/+$/g, '')).toLowerCase();
    const p = path.toLowerCase();
    return p === prefix || p.startsWith(prefix + '/');
  });
}

/** Cheap substring/extension match — ignorePatterns are not full globs, deliberately. */
export function matchesIgnorePattern(url: string, patterns: string[]): boolean {
  const lower = url.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    if (pat.startsWith('.')) return new URL(lower, 'https://x').pathname.endsWith(pat);
    return lower.includes(pat);
  });
}
