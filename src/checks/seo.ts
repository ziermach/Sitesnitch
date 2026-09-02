import type { Check, Issue } from '../types.js';
import { dedupeKey, isSameSite, normalizeUrl } from '../url.js';

export const seoCheck: Check = (ctx, { config }): Issue[] => {
  const issues: Issue[] = [];
  const dom = ctx.dom;
  if (!dom) return issues;

  // A 404 page is *supposed* to have a thin title and a noindex tag. Running SEO rules on
  // one produces a page of noise that says nothing the http-status check didn't already.
  if (ctx.status >= 400) return issues;

  const add = (
    severity: Issue['severity'],
    rule: string,
    message: string,
    extra?: Partial<Issue>,
  ): void => {
    issues.push({ check: 'seo', severity, rule, message, pageUrl: ctx.url, ...extra });
  };

  // Title
  if (!dom.title) {
    add('error', 'missing-title', 'Page has no <title>');
  } else {
    const len = dom.title.length;
    if (len < config.seo.titleMin) {
      add('warning', 'title-too-short', `Title is ${len} chars (min ${config.seo.titleMin})`, {
        detail: dom.title,
      });
    } else if (len > config.seo.titleMax) {
      add('warning', 'title-too-long', `Title is ${len} chars (max ${config.seo.titleMax}) — will be truncated in search results`, {
        detail: dom.title,
      });
    }
  }

  // Meta description
  if (!dom.metaDescription) {
    add('warning', 'missing-meta-description', 'Page has no meta description');
  } else {
    const len = dom.metaDescription.length;
    if (len < config.seo.descriptionMin) {
      add('warning', 'description-too-short', `Meta description is ${len} chars (min ${config.seo.descriptionMin})`, {
        detail: dom.metaDescription,
      });
    } else if (len > config.seo.descriptionMax) {
      add('warning', 'description-too-long', `Meta description is ${len} chars (max ${config.seo.descriptionMax}) — will be truncated`, {
        detail: dom.metaDescription,
      });
    }
  }

  // H1
  if (dom.h1s.length === 0) {
    add('error', 'missing-h1', 'Page has no <h1>');
  } else if (dom.h1s.length > 1) {
    add('error', 'multiple-h1', `Page has ${dom.h1s.length} <h1> elements`, {
      detail: dom.h1s.map((h) => `"${h}"`).join(', '),
    });
  }

  // robots meta. A noindex shipped to a live marketing page silently removes it from
  // search — the page looks perfect and simply isn't there. Worth an error.
  const robotsMeta = dom.metaRobots?.toLowerCase() ?? '';
  if (robotsMeta.includes('noindex')) {
    add('error', 'noindex-on-live-page', 'Page is marked noindex', {
      detail: dom.metaRobots ?? undefined,
    });
  }

  // Canonical
  if (!dom.canonical) {
    add('warning', 'missing-canonical', 'Page has no canonical link');
  } else {
    const canonical = normalizeUrl(dom.canonical);
    if (!canonical) {
      add('error', 'invalid-canonical', 'Canonical is not a valid URL', { detail: dom.canonical });
    } else if (!isSameSite(canonical, config.baseUrl)) {
      // Note the deliberate overlap with forbidden-hosts: a canonical pointing at
      // a staging host is caught by both, and that is fine. This one fires for *any*
      // off-site canonical, staging or not, because that's an SEO defect on its own.
      add('error', 'canonical-off-site', 'Canonical points to a different site', {
        target: canonical,
        where: 'link[rel=canonical]',
      });
    }
  }

  // Open Graph — what the page looks like when someone shares it.
  if (!dom.og['og:title']) add('warning', 'missing-og-title', 'Missing og:title');
  if (!dom.og['og:image']) add('warning', 'missing-og-image', 'Missing og:image');
  if (!dom.og['og:description']) add('warning', 'missing-og-description', 'Missing og:description');

  // lang
  if (!dom.htmlLang) {
    add('warning', 'missing-html-lang', 'Missing <html lang> attribute');
  }

  // hreflang: a self-reference is required by the spec, and its absence is the single
  // most common reason a correct-looking hreflang cluster is ignored by search engines.
  if (dom.hreflang.length > 0) {
    const selfUrl = dedupeKey(ctx.finalUrl);
    const hasSelf = dom.hreflang.some((alt) => dedupeKey(alt.href) === selfUrl);
    if (!hasSelf) {
      add('warning', 'hreflang-missing-self', 'hreflang cluster does not include a self-reference', {
        detail: dom.hreflang.map((a) => a.hreflang).join(', '),
      });
    }
  }

  return issues;
};
