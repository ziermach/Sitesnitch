import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_META, classify, priorityRank } from '../src/classify.js';

describe('rule classification', () => {
  /**
   * Every `rule:` string the source can emit must be ranked.
   *
   * An unclassified rule falls back to P2 and sorts into the middle of the report, where a
   * genuinely critical finding would go unnoticed. Rather than trust a hand-kept list to
   * stay in sync, this scrapes the actual rule literals out of the checks and asserts each
   * one is known — so adding a check without ranking it fails here, not in production.
   */
  it('classifies every rule the checks can emit', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files = globSync('**/*.ts', { cwd: root }).map((f) => readFileSync(root + f, 'utf8'));

    const emitted = new Set<string>();
    for (const src of files) {
      for (const m of src.matchAll(/\brule:\s*'([a-z0-9-]+)'/g)) {
        if (m[1]) emitted.add(m[1]);
      }
    }

    expect(emitted.size).toBeGreaterThan(20);

    const unclassified = [...emitted].filter((rule) => !(rule in RULE_META));
    expect(unclassified, `unranked rules — add them to RULE_META in src/classify.ts`).toEqual([]);
  });

  it('puts every staging-leak rule at P0', () => {
    // The reason the tool exists. If one of these ever drifts below P0, it stops being the
    // first thing anyone sees in the report.
    const leakRules = Object.keys(RULE_META).filter((r) => r.startsWith('forbidden-host'));
    expect(leakRules.length).toBeGreaterThan(5);
    for (const rule of leakRules) {
      expect(classify(rule).priority, rule).toBe('P0');
      expect(classify(rule).category, rule).toBe('environment-leak');
    }
  });

  it('ranks a staging leak above a missing alt attribute', () => {
    // The concrete triage failure this whole taxonomy exists to prevent: 670 missing <h1>s
    // and 4,600 missing alts drowning a privacy policy that points at staging.
    expect(priorityRank(classify('forbidden-host-in-link').priority)).toBeLessThan(
      priorityRank(classify('missing-alt').priority),
    );
    expect(priorityRank(classify('server-error').priority)).toBeLessThan(
      priorityRank(classify('title-too-long').priority),
    );
  });

  it('gives every rule a rationale, so the ranking can be argued with', () => {
    for (const [rule, meta] of Object.entries(RULE_META)) {
      expect(meta.rationale.length, rule).toBeGreaterThan(15);
    }
  });
});
