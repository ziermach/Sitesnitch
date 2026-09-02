import type { Check, Issue, PageContext } from '../types.js';
import { hostOf, matchForbiddenHost } from '../url.js';

/**
 * Finds references to environments that must never be reachable from production: the hosts
 * listed in `forbiddenHosts` (staging.example.com, dev.example.com, an ngrok tunnel),
 * localhost, and friends.
 *
 * The reason this check reads four separate surfaces rather than just scanning `<a href>`
 * is that a link is the *least* likely way this leaks. In practice a staging host arrives
 * as an image CDN swapped in a config file, a canonical tag templated from the wrong
 * env var, a redirect an ops change left behind, or an analytics call fired from JS that
 * never appears in the HTML at all. A DOM-only check reports a clean site and is wrong.
 *
 * Every finding here is an error. There is no acceptable number of staging links in prod.
 */
export const forbiddenHostsCheck: Check = (ctx, { config }): Issue[] => {
  const issues: Issue[] = [];
  const patterns = config.forbiddenHosts;
  const seen = new Set<string>();

  /**
   * The host of the site being crawled.
   *
   * A site cannot leak itself, and this matters the moment anyone points the crawler at
   * `http://localhost:3000` — a perfectly normal thing to do against a dev server or in
   * CI. Without this, `localhostHosts` matches the site's own origin and every asset and
   * every XHR on every page is reported as a localhost leak: hundreds of errors, all of
   * them false, on the check that must never cry wolf.
   */
  const ownHost = hostOf(config.baseUrl);

  const report = (
    target: string,
    where: string,
    rule: string,
    detail?: string,
  ): void => {
    let pattern = matchForbiddenHost(target, patterns);

    // localhost is judged by surface, not by host.
    //
    // `<a href="http://localhost:11434">` inside a tutorial about running Ollama is the
    // article doing its job. The same host as a stylesheet, an image, or an XHR is a
    // shipped bug that breaks for every visitor. Flagging the prose case taught the report
    // to lie about the blog; ignoring the asset case would miss a real defect.
    if (!pattern && where !== 'a[href]' && hostOf(target) !== ownHost) {
      pattern = matchForbiddenHost(target, config.localhostHosts);
    }

    if (!pattern) return;

    // Dedupe on the full URL, not the host.
    //
    // The same *link* repeated down a nav or a listing is one finding. But a page that
    // leaks a dozen different staging URLs is a dozen things to fix, and collapsing them
    // by host would report "1 leak" and hide both the scale and — worse — which URLs to
    // go and change. Under-reporting the flagship check is the one thing this tool cannot
    // do. (Observed for real: a single product page carried 12 distinct staging URLs.)
    const key = `${rule}:${where}:${target}`;
    if (seen.has(key)) return;
    seen.add(key);

    issues.push({
      check: 'forbidden-hosts',
      severity: 'error',
      rule,
      message: `Forbidden host "${new URL(target).hostname}" (matches "${pattern}") referenced in ${where}`,
      pageUrl: ctx.url,
      target,
      where,
      detail,
    });
  };

  // Surface 1: the DOM — links, assets, canonical, hreflang, og:url, form actions.
  if (ctx.dom) {
    for (const link of ctx.dom.links) report(link.href, 'a[href]', 'forbidden-host-in-link');
    for (const res of ctx.dom.resources) report(res.url, res.where, 'forbidden-host-in-resource');
    if (ctx.dom.canonical) {
      report(ctx.dom.canonical, 'link[rel=canonical]', 'forbidden-host-in-canonical');
    }
    for (const alt of ctx.dom.hreflang) {
      report(alt.href, `link[hreflang=${alt.hreflang}]`, 'forbidden-host-in-hreflang');
    }
    for (const [key, value] of Object.entries(ctx.dom.og)) {
      if (value.startsWith('http')) report(value, `meta[${key}]`, 'forbidden-host-in-og');
    }

    // Surface 4: inline scripts and JSON-LD. A host can be sitting in a config blob that
    // nothing has requested *yet* — a staged rollout, a feature-flagged endpoint. It is
    // still shipped to every visitor, and it is still a leak.
    for (const script of ctx.dom.inlineScripts) {
      for (const url of extractUrls(script)) {
        report(url, 'inline-script', 'forbidden-host-in-inline-script', truncate(script, 200));
      }
    }
  }

  // Surface 2: the network. Catches anything JS built at runtime — the case the HTML
  // cannot show you.
  for (const requestUrl of ctx.requestUrls) {
    report(requestUrl, 'network', 'forbidden-host-in-request');
  }

  // Surface 3: the redirect chain. A prod URL that bounces through staging on its way to
  // a 200 looks perfectly healthy if you only check the final status.
  for (const hop of ctx.redirectChain) {
    report(hop, 'redirect-chain', 'forbidden-host-in-redirect', ctx.redirectChain.join(' -> '));
  }
  report(ctx.finalUrl, 'final-url', 'forbidden-host-in-redirect');

  return issues;
};

/** Pulls absolute http(s) URLs out of arbitrary script text. */
function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'`<>()\\]+/g) ?? [];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Scans a plain text document (llms.txt, robots.txt) for forbidden hosts. */
export function scanTextForForbiddenHosts(
  text: string,
  patterns: string[],
  sourceUrl: string,
): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();

  for (const url of extractUrls(text)) {
    const pattern = matchForbiddenHost(url, patterns);
    if (!pattern) continue;
    const host = new URL(url).hostname;
    if (seen.has(host)) continue;
    seen.add(host);

    issues.push({
      check: 'forbidden-hosts',
      severity: 'error',
      rule: 'forbidden-host-in-text-file',
      message: `Forbidden host "${host}" (matches "${pattern}") referenced in ${sourceUrl}`,
      pageUrl: sourceUrl,
      target: url,
      where: sourceUrl,
    });
  }

  return issues;
}

/** Exposed for the fixture test: does this page context contain any leak at all? */
export function hasForbiddenHost(ctx: PageContext, patterns: string[]): boolean {
  const urls = [
    ...ctx.requestUrls,
    ...ctx.redirectChain,
    ...(ctx.dom?.links.map((l) => l.href) ?? []),
    ...(ctx.dom?.resources.map((r) => r.url) ?? []),
  ];
  return urls.some((u) => matchForbiddenHost(u, patterns) !== null);
}
