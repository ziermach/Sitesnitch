import type { Check, Issue } from '../types.js';

/**
 * An http:// subresource on an https:// page. Browsers block or upgrade these, so the
 * practical symptom is a missing image or a script that never runs — a defect that looks
 * like a rendering bug and gets debugged as one.
 */
export const mixedContentCheck: Check = (ctx): Issue[] => {
  const issues: Issue[] = [];
  if (!ctx.dom) return issues;
  if (!ctx.finalUrl.startsWith('https://')) return issues;

  const seen = new Set<string>();

  const report = (url: string, where: string): void => {
    if (!url.startsWith('http://')) return;
    if (seen.has(url)) return;
    seen.add(url);
    issues.push({
      check: 'mixed-content',
      severity: 'error',
      rule: 'insecure-subresource',
      message: 'Insecure http:// resource loaded on an https:// page',
      pageUrl: ctx.url,
      target: url,
      where,
    });
  };

  for (const res of ctx.dom.resources) report(res.url, res.where);
  for (const req of ctx.requestUrls) report(req, 'network');

  return issues;
};
