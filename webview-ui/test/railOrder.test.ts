import { describe, expect, it } from 'vitest';

import { sortByRailOrder } from '../src/office/railOrder.js';

describe('sortByRailOrder', () => {
  it('follows the order, then unknown ids ascending', () => {
    expect(sortByRailOrder([1, 2, 3, 9, 4], [3, 1])).toEqual([3, 1, 2, 4, 9]);
  });
  it('ignores order entries that are not in ids', () => {
    expect(sortByRailOrder([5, 6], [7, 6, 8])).toEqual([6, 5]);
  });
  it('empty order is ascending id', () => {
    expect(sortByRailOrder([3, 1, 2], [])).toEqual([1, 2, 3]);
  });
  it('a duplicated id in the order counts once', () => {
    expect(sortByRailOrder([1, 2], [2, 2, 1])).toEqual([2, 1]);
  });
});
