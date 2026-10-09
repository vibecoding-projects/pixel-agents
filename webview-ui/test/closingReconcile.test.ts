import { describe, expect, it } from 'vitest';

import { reconcileClosingIds } from '../src/office/closingReconcile.js';

describe('reconcileClosingIds (existingAgents handshake)', () => {
  it('unmarks ids the server no longer reports as closing (another tab undid, or finalized)', () => {
    const r = reconcileClosingIds(new Set([1, 2]), new Set([2]), () => false);
    expect(r.unmark).toEqual([1]);
    expect(r.tearDown).toEqual([]);
  });

  it('tears down closing ids this tab still holds as live (the close happened while disconnected)', () => {
    const r = reconcileClosingIds(new Set(), new Set([3, 4]), (id) => id === 3);
    expect(r.tearDown).toEqual([3]);
    expect(r.unmark).toEqual([]);
  });

  it('is empty when both sides agree', () => {
    const r = reconcileClosingIds(new Set([5]), new Set([5]), () => false);
    expect(r).toEqual({ unmark: [], tearDown: [] });
  });
});
