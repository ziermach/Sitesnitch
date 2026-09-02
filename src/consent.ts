import type { BrowserContext, Page } from 'playwright';

/**
 * Cookie-consent handling.
 *
 * This is not cosmetic. If a consent overlay blocks rendering or gates script execution,
 * every page looks the same, no third-party script runs, and half the checks silently
 * pass on a page that was never really loaded. A crawl that is quietly measuring nothing
 * is worse than one that fails, so we both suppress the banner *and* detect when
 * suppression failed.
 *
 * Consent platforms differ per site (Usercentrics, OneTrust, Cookiebot, homegrown). Rather
 * than depend on one vendor's exact cookie format, we pre-seed the consent keys they have
 * in common and fall back to clicking the accept button.
 */

const CONSENT_COOKIE_NAMES = [
  'uc_user_interaction',
  'uc_settings',
  'CookieConsent',
  'cookie_consent',
  'OptanonAlertBoxClosed',
];

/** Buttons that dismiss a consent banner, most-specific first. */
const ACCEPT_SELECTORS = [
  '[data-testid="uc-accept-all-button"]',
  '#uc-btn-accept-banner',
  'button#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Aceptar todo")',
];

/** Overlays whose presence after load means the page under them was never really measured. */
const BANNER_SELECTORS = [
  '#usercentrics-root',
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '[id*="cookie-banner"]',
  '[class*="cookie-consent"]',
];

/**
 * Pre-seeds consent state before the first navigation, so the banner never appears and
 * never blocks scripts. Cheaper and far more reliable than clicking it on every page.
 */
export async function seedConsent(context: BrowserContext, baseUrl: string): Promise<void> {
  const domain = new URL(baseUrl).hostname;
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;

  await context.addCookies(
    CONSENT_COOKIE_NAMES.map((name) => ({
      name,
      value: 'true',
      domain: `.${domain}`,
      path: '/',
      expires,
    })),
  );

  // Usercentrics keeps its real state in localStorage, not cookies. Seed it for every
  // origin we touch, before any page script runs.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'uc_settings',
        JSON.stringify({ controllerId: 'crawler', version: '1', services: [] }),
      );
      window.localStorage.setItem('uc_user_interaction', 'true');
      window.localStorage.setItem('uc_ui_version', '3.0.0');
    } catch {
      // Storage can be unavailable (sandboxed/about:blank); the click fallback covers us.
    }
  });
}

/**
 * Fallback: click the accept button if a banner showed up anyway.
 * Returns true if a banner is *still* visible afterwards — i.e. the page is masked and
 * anything we measured on it is suspect.
 */
export async function dismissConsent(page: Page): Promise<boolean> {
  for (const selector of ACCEPT_SELECTORS) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 250 })) {
        await button.click({ timeout: 1000 });
        await page.waitForTimeout(300);
        break;
      }
    } catch {
      // Selector didn't resolve or the click raced a re-render — try the next one.
    }
  }

  return isBannerVisible(page);
}

export async function isBannerVisible(page: Page): Promise<boolean> {
  for (const selector of BANNER_SELECTORS) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 200 })) return true;
    } catch {
      // Not present. Fine.
    }
  }
  return false;
}
