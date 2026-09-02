import { chromium } from 'playwright';
import type { ResolvedConfig } from './config.js';
import { isBannerVisible } from './consent.js';
import type { Issue } from './types.js';

/**
 * Cookie consent must appear for a visitor who has never accepted it — that's the entire
 * legal basis for showing it at all. Every other pass in this crawler pre-seeds consent
 * (src/consent.ts, seedConsent()) specifically so measurements aren't taken through the
 * overlay, which means the main crawl can never tell us whether the banner would actually
 * show for a real first-time visitor. This is a second, tiny pass: one fresh, unseeded
 * browser context per locale root — no cookies, no seeded storage — asserting the banner
 * is there.
 *
 * Scoped to locale roots, not every crawled page. Sitemap seeding stamps depth 0 on
 * thousands of URLs (see cli.ts seedFromSitemap), not just homepages, so re-visiting
 * "every depth-0 page" in a second browser pass would be exactly the load-generator
 * mistake CLAUDE.md warns against. A handful of roots is enough to catch a CMP that
 * failed to load site-wide.
 */
export async function runConsentBannerCheck(config: ResolvedConfig): Promise<Issue[]> {
  const routes = landingRoutes(config);
  if (routes.length === 0) return [];

  const issues: Issue[] = [];
  const browser = await chromium.launch({ headless: true });

  try {
    for (const url of routes) {
      const context = await browser.newContext({
        userAgent: config.userAgent,
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: false,
      });

      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.requestTimeout });
        // Give the CMP script a moment to render — it's usually the last thing to paint.
        await page.waitForTimeout(1_000);

        if (!(await isBannerVisible(page))) {
          issues.push({
            check: 'consent-banner',
            severity: 'error',
            rule: 'consent-banner-missing',
            message:
              'No cookie-consent banner appeared for a first-time visitor in a fresh, unseeded browser context',
            pageUrl: url,
          });
        }
      } catch (err) {
        issues.push({
          check: 'consent-banner',
          severity: 'warning',
          rule: 'consent-banner-check-failed',
          message: `Could not verify the consent banner: ${err instanceof Error ? err.message : String(err)}`,
          pageUrl: url,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  return issues;
}

function landingRoutes(config: ResolvedConfig): string[] {
  if (config.locales.length === 0) return [config.baseUrl];
  return config.locales.map((locale) => new URL(`/${locale}/`, config.baseUrl).href);
}
