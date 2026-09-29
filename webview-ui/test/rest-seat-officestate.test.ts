/**
 * OfficeState rest-claim lifecycle + awaiting-user latch (Task 4 of the
 * m1.5 character-behaviors slice). Task 3 taught the FSM to claim/release
 * rest seats via `Character.restSeatId`; this file pins the OfficeState-side
 * bookkeeping around it: freeing rest claims on agent/sub-agent removal,
 * clearing every claim on `rebuildFromLayout` (whose pass-1 keep now also
 * requires a WORK seat), and the `setAwaitingSince` mutator consumed by
 * useExtensionMessages' `agentStatus` handler. Also pins the scope-addendum
 * fix restoring `isActive: true` on sub-agent spawn.
 *
 * Construction mirrors work-seat-selection.test.ts (a synthetic OfficeLayout
 * fed straight to `new OfficeState(...)`, with a minimal in-memory catalog).
 *
 * Run with: npm run test:webview -- test/rest-seat-officestate.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { AWAITING_REST_DELAY_MS } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

/** Install a minimal in-memory catalog: a desk-facing chair + monitor (work
 *  seat when paired) and a couch (always rest, per its own orientation). */
function installTestCatalog(): void {
  // eslint-disable-next-line pixel-agents/no-inline-colors
  const tinySprite = [['#000000']];
  // eslint-disable-next-line pixel-agents/no-inline-colors
  const wideSprite = [['#000000', '#000000']];
  buildDynamicCatalog({
    catalog: [
      {
        id: 'DESK',
        label: 'Desk',
        category: 'desks',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: true,
      },
      {
        id: 'MONITOR',
        label: 'Monitor',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        canPlaceOnSurfaces: true,
      },
      {
        id: 'CHAIR_FRONT',
        label: 'Chair',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        orientation: 'front',
      },
      {
        id: 'COUCH',
        label: 'Couch',
        category: 'chairs',
        width: 32,
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: false,
        orientation: 'front',
      },
    ],
    sprites: {
      DESK: tinySprite,
      MONITOR: tinySprite,
      CHAIR_FRONT: tinySprite,
      COUCH: wideSprite,
    },
  });
}

/** All-floor layout, no walls — every tile walkable except furniture footprints. */
function floorLayout(cols = 12, rows = 10): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

/** One work seat (chair-1, facing a monitored desk) + two rest seats
 *  (couch-1 / couch-1:1, a 2-wide couch elsewhere in the room). */
function layoutWithWorkAndRestSeats(): OfficeLayout {
  const layout = floorLayout();
  layout.furniture = [
    { uid: 'chair-1', type: 'CHAIR_FRONT', col: 5, row: 5 },
    { uid: 'desk-1', type: 'DESK', col: 5, row: 6 },
    { uid: 'monitor-1', type: 'MONITOR', col: 5, row: 6 },
    { uid: 'couch-1', type: 'COUCH', col: 2, row: 2 },
  ];
  return layout;
}

describe('OfficeState rest-claim lifecycle', () => {
  beforeEach(() => {
    installTestCatalog();
  });

  it('removeAgent frees a claimed rest seat', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    const restSeat = os.seats.get('couch-1')!;
    // Simulate the FSM having claimed the rest seat while resting.
    ch.restSeatId = 'couch-1';
    restSeat.assigned = true;

    os.removeAgent(1);

    expect(restSeat.assigned).toBe(false);
  });

  it('removeSubagent frees a stale rest claim', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const subId = os.addSubagent(1, 'tool-1');
    const sub = os.characters.get(subId)!;
    const restSeat = os.seats.get('couch-1')!;
    // Defensive belt: the FSM never lets a sub-agent claim a rest seat, but
    // a stale claim must still be freed on removal.
    sub.restSeatId = 'couch-1';
    restSeat.assigned = true;

    os.removeSubagent(1, 'tool-1');

    expect(restSeat.assigned).toBe(false);
  });

  it('rebuildFromLayout clears every rest claim and frees the seats', () => {
    const layout = layoutWithWorkAndRestSeats();
    const os = new OfficeState(layout);
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    const workSeatId = ch.seatId!;
    expect(os.seats.get(workSeatId)!.role).toBe('work');
    ch.restSeatId = 'couch-1';
    os.seats.get('couch-1')!.assigned = true;

    os.rebuildFromLayout(layout);

    expect(ch.restSeatId).toBeNull();
    // Claims are transient: an IDLE agent keeps its PREFERENCE, not the chair.
    expect(ch.preferredSeatId).toBe(workSeatId);
    expect(ch.seatId).toBeNull();
    expect(os.seats.get(workSeatId)!.assigned).toBe(false);
    expect(os.seats.get('couch-1')!.assigned).toBe(false);
  });

  it('rebuildFromLayout re-claims for an ACTIVE agent whose preferred chair demoted to rest', () => {
    const initial = layoutWithWorkAndRestSeats();
    const os = new OfficeState(initial);
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    expect(ch.seatId).toBe('chair-1');
    os.setAgentActive(1, true);

    // Rebuild: monitor removed (chair-1 demotes to rest) + a NEW work seat
    // (chair-2, facing its own monitored desk) added elsewhere.
    const rebuilt = layoutWithWorkAndRestSeats();
    rebuilt.furniture = rebuilt.furniture.filter((f) => f.uid !== 'monitor-1');
    rebuilt.furniture.push(
      { uid: 'chair-2', type: 'CHAIR_FRONT', col: 8, row: 5 },
      { uid: 'desk-2', type: 'DESK', col: 8, row: 6 },
      { uid: 'monitor-2', type: 'MONITOR', col: 8, row: 6 },
    );

    os.rebuildFromLayout(rebuilt);

    expect(os.seats.get('chair-1')!.role).toBe('rest');
    expect(os.seats.get('chair-2')!.role).toBe('work');
    expect(ch.seatId).toBe('chair-2');
    expect(ch.preferredSeatId).toBeNull(); // the old preference is no longer a work seat
    expect(os.seats.get('chair-1')!.assigned).toBe(false);
  });

  it('rebuildFromLayout drops the preference of an IDLE agent whose chair disappeared and leaves it standing', () => {
    const initial = layoutWithWorkAndRestSeats();
    const os = new OfficeState(initial);
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    expect(ch.preferredSeatId).toBe('chair-1');

    const rebuilt = layoutWithWorkAndRestSeats();
    rebuilt.furniture = rebuilt.furniture.filter((f) => f.uid !== 'chair-1');
    os.rebuildFromLayout(rebuilt);

    expect(ch.seatId).toBeNull();
    expect(ch.preferredSeatId).toBeNull();
    expect(os.walkableTiles.some((t) => t.col === ch.tileCol && t.row === ch.tileRow)).toBe(true);
  });

  it('rebuildFromLayout re-claims for agents that should be seated and snaps them to the seat', () => {
    const layout = layoutWithWorkAndRestSeats();
    const os = new OfficeState(layout);
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, true);
    ch.tileCol = 0;
    ch.tileRow = 0;

    os.rebuildFromLayout(layout);

    expect(ch.seatId).toBe('chair-1');
    const seat = os.seats.get('chair-1')!;
    expect(seat.assigned).toBe(true);
    expect(ch.tileCol).toBe(seat.seatCol);
    expect(ch.tileRow).toBe(seat.seatRow);
  });

  it('setAwaitingSince stores and clears the latch', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);

    os.setAwaitingSince(1, 5);
    expect(os.characters.get(1)!.awaitingSince).toBe(5);

    os.setAwaitingSince(1, null);
    expect(os.characters.get(1)!.awaitingSince).toBeNull();
  });

  it('setAwaitingSince preserves a FRESH latch but replaces an expired one', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;

    // Fresh latch: a late idle_prompt must not restart the desk-hold clock.
    const t0 = 1_000_000_000;
    os.setAwaitingSince(1, t0);
    os.setAwaitingSince(1, t0 + 60_000);
    expect(ch.awaitingSince).toBe(t0);

    // Expired latch: a NEW turn-end waiting must re-latch, or the agent never
    // desk-holds again once the first latch aged out (stale-preserve bug).
    os.setAwaitingSince(1, t0 + AWAITING_REST_DELAY_MS + 60_000);
    expect(ch.awaitingSince).toBe(t0 + AWAITING_REST_DELAY_MS + 60_000);
  });

  it('addSubagent produces a sub-character with isActive true', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const subId = os.addSubagent(1, 'tool-1');
    expect(os.characters.get(subId)!.isActive).toBe(true);
  });
});
