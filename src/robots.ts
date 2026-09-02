export interface RobotsRules {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
  crawlDelayMs: number | null;
}

export const EMPTY_ROBOTS: RobotsRules = {
  disallow: [],
  allow: [],
  sitemaps: [],
  crawlDelayMs: null,
};

/**
 * Parses robots.txt, keeping only the rules that apply to us.
 *
 * We collect rules from the `User-agent: *` group. A named group for a specific bot
 * doesn't apply to this crawler, so it's ignored — same as any well-behaved crawler.
 * Sitemap directives are group-independent and always collected.
 */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [], crawlDelayMs: null };
  let inWildcardGroup = false;
  // robots.txt groups consecutive User-agent lines: `UA: a\nUA: b\nDisallow: /x` applies to both.
  let atGroupStart = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!atGroupStart) inWildcardGroup = false;
        atGroupStart = true;
        if (value === '*') inWildcardGroup = true;
        break;
      }
      case 'disallow': {
        atGroupStart = false;
        // An empty Disallow means "allow everything" — not a rule.
        if (inWildcardGroup && value) rules.disallow.push(value);
        break;
      }
      case 'allow': {
        atGroupStart = false;
        if (inWildcardGroup && value) rules.allow.push(value);
        break;
      }
      case 'crawl-delay': {
        atGroupStart = false;
        const seconds = Number(value);
        if (inWildcardGroup && Number.isFinite(seconds)) rules.crawlDelayMs = seconds * 1000;
        break;
      }
      case 'sitemap': {
        atGroupStart = false;
        if (value) rules.sitemaps.push(value);
        break;
      }
      default:
        atGroupStart = false;
    }
  }

  return rules;
}

/**
 * Converts a robots.txt path pattern to a regex.
 * `*` matches any run of characters; a trailing `$` anchors the end. Everything else is literal.
 */
function patternToRegex(pattern: string): RegExp {
  let p = pattern;
  let anchoredEnd = false;
  if (p.endsWith('$')) {
    anchoredEnd = true;
    p = p.slice(0, -1);
  }
  const escaped = p
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + (anchoredEnd ? '$' : ''));
}

/**
 * Is this URL allowed?
 *
 * Per the robots spec, the most specific (longest) matching rule wins, and Allow beats
 * Disallow on a tie. Plenty of robots.txt files carry no Allow rules at all, but one that
 * carves an exception out of a broad Disallow would silently be ignored without this.
 */
export function isAllowed(url: string, rules: RobotsRules): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }

  const longestMatch = (patterns: string[]): number =>
    patterns.reduce((best, pattern) => {
      if (!patternToRegex(pattern).test(path)) return best;
      return Math.max(best, pattern.length);
    }, -1);

  const disallowLen = longestMatch(rules.disallow);
  if (disallowLen === -1) return true;

  const allowLen = longestMatch(rules.allow);
  return allowLen >= disallowLen;
}
