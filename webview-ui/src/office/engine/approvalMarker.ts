import { APPROVAL_MARKER_BOB_AMPLITUDE_PX, APPROVAL_MARKER_BOB_HZ } from '../../constants.js';

/** Vertical offset (sprite pixels, integer so the marker stays pixel-aligned)
 *  of the approval marker after `elapsedSec` on screen. Positive = up. */
export function approvalMarkerBobPx(elapsedSec: number): number {
  return Math.round(
    Math.sin(2 * Math.PI * APPROVAL_MARKER_BOB_HZ * elapsedSec) * APPROVAL_MARKER_BOB_AMPLITUDE_PX,
  );
}
