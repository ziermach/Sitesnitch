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
   * List exact hosts. Broad wildcards like `dev.*` will flag `dev.to` and `dev.mysql.com`
   * as leaked internal environments, and a check that cries wolf is a check people learn
   * to ignore.
   */
  forbiddenHosts: [
    'staging.example.com',
    'dev.example.com',
    '*.internal.example.com',
  ],

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
