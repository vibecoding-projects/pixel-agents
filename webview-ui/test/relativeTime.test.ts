import { describe, expect, it } from 'vitest';

import { relativeTime } from '../src/components/terminal/relativeTime.js';

describe('relativeTime', () => {
  const now = 1_000_000_000;
  it('buckets by minute, hour and day', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 120_000, now)).toBe('2 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
  it('never goes negative for a future timestamp', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now');
  });
});
