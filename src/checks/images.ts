import type { Check, Issue } from '../types.js';
import { urlBelongsTo } from '../url.js';

export const imagesCheck: Check = (ctx, { config }): Issue[] => {
  const issues: Issue[] = [];
  if (!ctx.dom) return issues;

  const seen = new Set<string>();

  for (const img of ctx.dom.images) {
    if (!img.src) continue;

    // Analytics beacons are 1x1 pixels that deliberately decode to nothing, and they are
    // injected into every page. Reporting them as broken images would put a false error on
    // every single page of the site.
    if (urlBelongsTo(img.src, config.trackingHosts)) continue;

    // naturalWidth of 0 on a complete image means the bytes never decoded. This catches
    // the case a status check misses: a CDN that answers 200 with an error page body.
    if (img.naturalWidth === 0 && !seen.has(`broken:${img.src}`)) {
      seen.add(`broken:${img.src}`);
      issues.push({
        check: 'images',
        severity: 'error',
        rule: 'broken-image',
        message: 'Image failed to load',
        pageUrl: ctx.url,
        target: img.src,
        where: 'img[src]',
      });
    }

    // A null alt is missing; alt="" is a deliberate "this image is decorative" and correct.
    if (img.alt === null && !seen.has(`alt:${img.src}`)) {
      seen.add(`alt:${img.src}`);
      issues.push({
        check: 'images',
        severity: 'warning',
        rule: 'missing-alt',
        message: 'Image has no alt attribute',
        pageUrl: ctx.url,
        target: img.src,
        where: 'img[src]',
      });
    }
  }

  return issues;
};
