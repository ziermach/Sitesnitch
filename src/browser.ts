import { chromium, type Browser } from 'playwright';

/**
 * Launches Chromium, and explains itself when it can't.
 *
 * This package deliberately does NOT download a browser in a postinstall hook. Playwright's
 * Chromium is ~150 MB, and a library that grabs it on `npm install` imposes that on every
 * consumer and every CI job that merely depends on the package — including ones that never
 * run a crawl. The cost belongs to whoever actually crawls.
 *
 * The price of that choice is a first-run failure mode, and an unhandled one is worse than
 * the download: Playwright's own error is a wall of text about executable paths that reads
 * like a bug in this tool. So the one thing the user needs — the command to run — is
 * surfaced on its own.
 */
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (isMissingBrowser(err)) throw new Error(missingBrowserMessage());
    throw err;
  }
}

/**
 * Is this Playwright telling us the browser binary was never downloaded?
 *
 * Matched on the message rather than a type, because Playwright throws a plain Error here.
 * Both markers are checked: the wording has changed between releases, and a false negative
 * costs the user the clear message while a false positive would mislabel some unrelated
 * launch failure as a missing install.
 */
export function isMissingBrowser(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Executable doesn't exist") ||
    message.includes('playwright install') ||
    message.includes('Please run the following command')
  );
}

function missingBrowserMessage(): string {
  return [
    'Chromium is not installed.',
    '',
    'sitesnitch drives a real browser, but does not download one on `npm install` —',
    'that would cost every consumer ~150 MB whether or not they ever run a crawl.',
    '',
    'Install it once:',
    '',
    '  npx playwright install chromium',
    '',
    'On a bare CI image you will also need its system libraries:',
    '',
    '  npx playwright install --with-deps chromium',
  ].join('\n');
}
