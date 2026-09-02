import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { PerOriginThrottle } from '../src/throttle.js';

describe('the concurrency settings only work in the right relationship', () => {
  it('keeps the global probe pool well above the per-origin cap', () => {
    // These two numbers do opposite jobs and are easy to mistake for duplicates:
    // perOriginConcurrency protects the site; linkConcurrency just bounds total in-flight
    // probes. Setting them close together means a handful of slow external links — each
    // burning a timeout — occupy every worker and starve the queue. Observed for real:
    // 15 links/min while example.com was answering HEAD in under a second.
    expect(DEFAULT_CONFIG.linkConcurrency).toBeGreaterThanOrEqual(
      DEFAULT_CONFIG.perOriginConcurrency * 4,
    );
  });

  it('keeps the per-origin cap genuinely small — it is the site\'s only protection', () => {
    expect(DEFAULT_CONFIG.perOriginConcurrency).toBeLessThanOrEqual(8);
  });
});

/**
 * This class is the thing standing between the crawler and the production site it is
 * measuring. An earlier build, without it, drove example.com into 30-second timeouts.
 * If the limit here silently drifts upward, nothing else in the system will notice.
 */
describe('PerOriginThrottle', () => {
  /** Tracks the high-water mark of concurrent calls the throttle actually permitted. */
  function tracker() {
    let active = 0;
    let peak = 0;
    return {
      peak: () => peak,
      task: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
    };
  }

  it('never exceeds the limit for one origin', async () => {
    const t = new PerOriginThrottle(3);
    const { peak, task } = tracker();

    await Promise.all(
      Array.from({ length: 20 }, () => t.run('https://example.com/x', task)),
    );

    expect(peak()).toBeLessThanOrEqual(3);
  });

  it('runs all the work it was given', async () => {
    const t = new PerOriginThrottle(2);
    let completed = 0;

    await Promise.all(
      Array.from({ length: 15 }, () =>
        t.run('https://example.com/x', async () => {
          await new Promise((r) => setTimeout(r, 5));
          completed++;
        }),
      ),
    );

    expect(completed).toBe(15);
  });

  it('does not let the limit drift upward across many handoffs', async () => {
    // The slot-handoff path is easy to get wrong: releasing a slot AND waking a waiter
    // double-counts, and the cap creeps up with every queued request. With 60 tasks through
    // a limit of 2, a drift bug shows up immediately.
    const t = new PerOriginThrottle(2);
    const { peak, task } = tracker();

    await Promise.all(Array.from({ length: 60 }, () => t.run('https://example.com/x', task)));

    expect(peak()).toBe(2);
  });

  it('throttles each origin independently', async () => {
    // A slow external host must not stall probing of example.com, and vice versa.
    const t = new PerOriginThrottle(2);
    const a = tracker();
    const b = tracker();

    await Promise.all([
      ...Array.from({ length: 10 }, () => t.run('https://example.com/x', a.task)),
      ...Array.from({ length: 10 }, () => t.run('https://docs.example.com/y', b.task)),
    ]);

    expect(a.peak()).toBeLessThanOrEqual(2);
    expect(b.peak()).toBeLessThanOrEqual(2);
  });

  it('releases the slot even when the task throws', async () => {
    // A failing probe that never released its slot would deadlock the whole origin.
    const t = new PerOriginThrottle(1);

    await expect(
      t.run('https://example.com/x', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    // If the slot leaked, this would hang rather than resolve.
    await expect(t.run('https://example.com/x', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
