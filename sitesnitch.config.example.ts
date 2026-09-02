import { defineConfig } from './src/index.js';

/**
 * Copy this to `sitesnitch.config.ts` and point it at your own site.
 *
 * Everything here is optional except `baseUrl` — see src/config.ts for the full list and
 * what each option costs. CLI flags override anything set here.
 */
export default defineConfig({
  baseUrl: 'https://example.com',

  /**
   * The environments that must never be reachable from production. This is the check the
   * tool exists for, and the one setting nobody else can guess for you.
   *
   * `*` is a glob: it stands for any run of characters, anywhere in the pattern and as
   * often as you like. Patterns are anchored, so `staging.*` matches
   * `staging.example.com` but not `not-staging.example.com`.
   *
   * Prefer exact hosts. Broad wildcards like `dev.*` will flag `dev.to` and
   * `dev.mysql.com` as leaked internal environments, and a check that cries wolf is a
   * check people learn to ignore.
   */
  forbiddenHosts: [
    'staging.example.com',
    'dev.example.com',
    '*.internal.example.com',
    'staging-*.example.com',
    '*.example.test',
  ],

  /**
   * Checks to switch off. Everything else still runs.
   *
   * The inverse of `checks` (`--only`), which is an allowlist. Use this when you want the
   * full crawl minus one noisy check, rather than having to list the other ten.
   */
  disabledChecks: ['accessibility'],

  /** Locale path prefixes, if the site is split that way. Omit for a single-locale site. */
  locales: ['en', 'de'],

  /**
   * Sub-sites with their own codebase and owners. Their findings land on a team that
   * cannot fix them, and their page count buries everything else. Crawl them separately
   * with `--paths /blog`.
   */
  excludePaths: ['/blog'],

  /** Sitemaps the main /sitemap.xml doesn't link to. */
  extraSitemaps: ['https://example.com/blog/sitemap_index.xml'],
});
