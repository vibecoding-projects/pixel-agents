import { describe, expect, it } from 'vitest';

import { APPROVAL_MARKER_BOB_AMPLITUDE_PX, APPROVAL_MARKER_BOB_HZ } from '../src/constants.js';
import { approvalMarkerBobPx } from '../src/office/engine/approvalMarker.js';
import markerApprovalData from '../src/office/sprites/marker-approval.json';
import { APPROVAL_MARKER_SPRITE } from '../src/office/sprites/spriteData.js';

describe('approval marker', () => {
  it('bobs between -amplitude and +amplitude in whole sprite pixels', () => {
    const period = 1 / APPROVAL_MARKER_BOB_HZ;
    expect(approvalMarkerBobPx(0)).toBe(0);
    expect(approvalMarkerBobPx(period / 4)).toBe(APPROVAL_MARKER_BOB_AMPLITUDE_PX);
    expect(approvalMarkerBobPx((3 * period) / 4)).toBe(-APPROVAL_MARKER_BOB_AMPLITUDE_PX);
    for (let t = 0; t < 3; t += 0.05) expect(Number.isInteger(approvalMarkerBobPx(t))).toBe(true);
  });

  it('is a 5x13 amber exclamation mark with an outline and no box', () => {
    expect(APPROVAL_MARKER_SPRITE).toHaveLength(13);
    for (const row of APPROVAL_MARKER_SPRITE) expect(row).toHaveLength(5);
    // Exactly the outline + the amber from the sprite's palette, nothing else.
    const palette = new Set(Object.values(markerApprovalData.palette).filter((c) => c !== ''));
    const colors = new Set(APPROVAL_MARKER_SPRITE.flat().filter((c) => c !== ''));
    expect(palette.size).toBe(2);
    expect(colors).toEqual(palette);
    // Corners are transparent: it is a glyph, not a bubble.
    expect(APPROVAL_MARKER_SPRITE[0][0]).toBe('');
    expect(APPROVAL_MARKER_SPRITE[12][4]).toBe('');
    // A gap row separates the stem from the dot.
    expect(APPROVAL_MARKER_SPRITE[8].every((c) => c === '')).toBe(true);
  });
});
