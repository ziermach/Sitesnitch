import { describe, expect, it } from 'vitest';
import {
  dedupeKey,
  hostMatches,
  isSameSite,
  localeOf,
  matchForbiddenHost,
  normalizeUrl,
} from '../src/url.js';

describe('normalizeUrl', () => {
  it('strips fragments and tracking params', () => {
    expect(normalizeUrl('https://example.com/en/vps?utm_source=x&gclid=y#pricing')).toBe(
      'https://example.com/en/vps',
    );
  });

  it('keeps meaningful query params, sorted', () => {
    expect(normalizeUrl('https://example.com/s?b=2&a=1')).toBe('https://example.com/s?a=1&b=2');
  });

  it('preserves the trailing slash as authored', () => {
    // Example 301s the slashless form to the slashed one. Stripping the slash here would
    // make every URL on the site look like a redirect and cost an extra request each.
    expect(normalizeUrl('https://example.com/en/vps/')).toBe('https://example.com/en/vps/');
    expect(normalizeUrl('https://example.com/en/vps')).toBe('https://example.com/en/vps');
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('/de/vps', 'https://example.com/en/')).toBe('https://example.com/de/vps');
    expect(normalizeUrl('../about', 'https://example.com/en/vps')).toBe('https://example.com/about');
  });

  it('rejects non-http schemes and garbage', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });

  it('lowercases the host but not the path', () => {
    expect(normalizeUrl('https://EXAMPLE.com/EN/VPS')).toBe('https://example.com/EN/VPS');
  });
});

describe('dedupeKey', () => {
  it('collapses the two slash forms to one identity', () => {
    expect(dedupeKey('https://example.com/en/vps/')).toBe(dedupeKey('https://example.com/en/vps'));
  });

  it('keeps the root slash', () => {
    expect(dedupeKey('https://example.com/')).toBe('https://example.com/');
  });

  it('still separates genuinely different pages', () => {
    expect(dedupeKey('https://example.com/en/vps')).not.toBe(dedupeKey('https://example.com/de/vps'));
  });
});

describe('isSameSite', () => {
  it('ignores www', () => {
    expect(isSameSite('https://www.example.com/en', 'https://example.com')).toBe(true);
  });

  it('rejects other hosts, including subdomains', () => {
    expect(isSameSite('https://staging.example.com/en', 'https://example.com')).toBe(false);
    expect(isSameSite('https://other-site.test', 'https://example.com')).toBe(false);
  });
});

describe('hostMatches', () => {
  it('matches exact hosts', () => {
    expect(hostMatches('dev.example.com', 'dev.example.com')).toBe(true);
    expect(hostMatches('example.com', 'dev.example.com')).toBe(false);
  });

  it('matches leading wildcards, including the bare suffix', () => {
    expect(hostMatches('api.local', '*.local')).toBe(true);
    expect(hostMatches('local', '*.local')).toBe(true);
    expect(hostMatches('notlocal', '*.local')).toBe(false);
  });

  it('matches trailing wildcards on the first label only', () => {
    expect(hostMatches('staging.example.com', 'staging.*')).toBe(true);
    expect(hostMatches('staging', 'staging.*')).toBe(true);
    // Must not match a host that merely *contains* the label — this is the case that
    // would otherwise flag production hosts like `my-staging-tips.example.com`.
    expect(hostMatches('not-staging.example.com', 'staging.*')).toBe(false);
  });
});

describe('matchForbiddenHost', () => {
  const patterns = ['staging.example.com', 'dev.example.com', 'localhost', '*.local'];

  it('catches the environments that must never ship', () => {
    expect(matchForbiddenHost('https://staging.example.com/en/vps', patterns)).toBe(
      'staging.example.com',
    );
    expect(matchForbiddenHost('https://dev.example.com/asset.js', patterns)).toBe(
      'dev.example.com',
    );
    expect(matchForbiddenHost('http://localhost:3000/api', patterns)).toBe('localhost');
  });

  it('leaves production URLs alone', () => {
    expect(matchForbiddenHost('https://example.com/en/vps', patterns)).toBeNull();
    expect(matchForbiddenHost('https://www.example.com/', patterns)).toBeNull();
  });
});

describe('localeOf', () => {
  const locales = ['en', 'es', 'de', 'en-us'];

  it('reads the first path segment when it is a locale', () => {
    expect(localeOf('https://example.com/de/vps', locales)).toBe('de');
    expect(localeOf('https://example.com/en-us/vps', locales)).toBe('en-us');
  });

  it('returns null for locale-less paths', () => {
    expect(localeOf('https://example.com/', locales)).toBeNull();
    expect(localeOf('https://example.com/blog/post', locales)).toBeNull();
  });
});
