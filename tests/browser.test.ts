import { describe, expect, it } from 'vitest';

import { isMissingBrowser } from '../src/browser.js';

/**
 * This package has no postinstall hook, so "the browser was never downloaded" is a real
 * first-run state rather than an exotic one. Playwright's own error for it is a wall of
 * text about executable paths that reads like a bug in this tool, so it gets translated —
 * and the translation is only as good as the detection.
 */
describe('missing-browser detection', () => {
  it('recognises the shapes Playwright actually throws', () => {
    // Taken from Playwright's own message. The wording has shifted between releases, which
    // is why more than one marker is matched.
    expect(
      isMissingBrowser(
        new Error(
          "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
        ),
      ),
    ).toBe(true);

    expect(
      isMissingBrowser(
        new Error('Please run the following command to download new browsers:\nnpx playwright install'),
      ),
    ).toBe(true);
  });

  it('does not mislabel an unrelated launch failure', () => {
    // A false positive here tells someone to reinstall a browser they already have, and
    // sends them looking in the wrong place entirely.
    expect(isMissingBrowser(new Error('browserType.launch: Target page, context or browser has been closed'))).toBe(false);
    expect(isMissingBrowser(new Error('connect ECONNREFUSED 127.0.0.1:9222'))).toBe(false);
    expect(isMissingBrowser(new Error('Timeout 30000ms exceeded'))).toBe(false);
  });

  it('survives a thrown non-Error', () => {
    expect(isMissingBrowser("Executable doesn't exist at /x")).toBe(true);
    expect(isMissingBrowser(undefined)).toBe(false);
    expect(isMissingBrowser(null)).toBe(false);
  });
});
