import { describe, expect, it } from 'vitest';

import { hasPendingPermission } from '../src/office/toolUtils.js';

describe('hasPendingPermission', () => {
  it('is true while any not-done tool row waits for approval', () => {
    expect(
      hasPendingPermission([
        { toolId: 'a', status: 'Bash: ls', done: true, permissionWait: true },
        { toolId: 'b', status: 'Edit: x', done: false, permissionWait: true },
      ]),
    ).toBe(true);
  });
  it('is false once every approval-waiting row is done (the approved tool ran)', () => {
    expect(
      hasPendingPermission([
        { toolId: 'a', status: 'Bash: ls', done: true, permissionWait: true },
        { toolId: 'b', status: 'Read: y', done: false },
      ]),
    ).toBe(false);
    expect(hasPendingPermission([])).toBe(false);
    expect(hasPendingPermission(undefined)).toBe(false);
  });
});
