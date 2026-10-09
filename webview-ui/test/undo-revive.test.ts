/**
 * Undo inside the 0.3 s despawn animation: agentClosing starts the despawn,
 * and agentCreated{restored} must REVIVE the same character rather than be
 * swallowed by addAgent's "already exists" guard (which would leave a rail
 * entry with no character once the despawn completes).
 *
 * Run with: npm run test:webview -- test/undo-revive.test.ts
 */
import { describe, expect, it } from 'vitest';

import { MATRIX_EFFECT_DURATION_SEC } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floorLayout(cols = 12, rows = 10): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: Array.from({ length: cols * rows }, () => TileType.FLOOR_1),
    furniture: [],
  };
}

describe('addAgent during a despawn (undo close)', () => {
  it('revives the despawning character instead of letting it finish despawning', () => {
    const os = new OfficeState(floorLayout());
    os.addAgent(1);
    os.removeAgent(1);
    expect(os.characters.get(1)?.matrixEffect).toBe('despawn');

    os.addAgent(1, undefined, undefined, undefined, true);
    expect(os.characters.get(1)?.matrixEffect).not.toBe('despawn');

    // Let what would have been the despawn finish: the character must survive.
    for (let i = 0; i < 10; i++) os.update(MATRIX_EFFECT_DURATION_SEC / 2);
    expect(os.characters.has(1)).toBe(true);
    expect(os.characters.get(1)?.matrixEffect).toBeNull();
  });

  it('is still a no-op for a live (non-despawning) character', () => {
    const os = new OfficeState(floorLayout());
    os.addAgent(1, 2, 45);
    os.addAgent(1, 3, 90);
    expect(os.characters.get(1)?.palette).toBe(2);
  });
});
