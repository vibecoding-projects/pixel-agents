/**
 * Work-seat preference for seat assignment (Task 2 of the m1.5
 * character-behaviors slice). Task 1 taught `layoutToSeats` to classify each
 * seat `work` (faces a computer) or `rest` (couch/idle seat). This file pins
 * the assignment-side consequences: auto-pick prefers work seats with an
 * any-seat fallback so computer-less layouts don't strand every agent
 * seatless, manual reassignment refuses to seat an agent on a rest seat, and
 * an explicit `preferredSeatId` is honored only when it points at a free work
 * seat.
 *
 * Construction mirrors `greeter.test.ts` (a synthetic all-floor `OfficeLayout`
 * fed straight to `new OfficeState(...)`) and the catalog fixture mirrors
 * `seat-classification.test.ts`'s `installTestCatalog()`.
 *
 * Run with: npm run test:webview -- test/work-seat-selection.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

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
  const furniture: PlacedFurniture[] = [
    { uid: 'chair-1', type: 'CHAIR_FRONT', col: 5, row: 5 },
    { uid: 'desk-1', type: 'DESK', col: 5, row: 6 },
    { uid: 'monitor-1', type: 'MONITOR', col: 5, row: 6 },
    { uid: 'couch-1', type: 'COUCH', col: 2, row: 2 },
  ];
  layout.furniture = furniture;
  return layout;
}

/** Computer-less layout: a couch only, no chair ever faces a monitor. */
function layoutWithOnlyRestSeats(): OfficeLayout {
  const layout = floorLayout();
  layout.furniture = [{ uid: 'couch-1', type: 'COUCH', col: 2, row: 2 }];
  return layout;
}

/** Two work seats (chair-1 at (5,5), chair-2 at (8,5)), no rest seats. */
function layoutWithTwoWorkSeats(): OfficeLayout {
  const layout = floorLayout();
  layout.furniture = [
    { uid: 'chair-1', type: 'CHAIR_FRONT', col: 5, row: 5 },
    { uid: 'desk-1', type: 'DESK', col: 5, row: 6 },
    { uid: 'monitor-1', type: 'MONITOR', col: 5, row: 6 },
    { uid: 'chair-2', type: 'CHAIR_FRONT', col: 8, row: 5 },
    { uid: 'desk-2', type: 'DESK', col: 8, row: 6 },
    { uid: 'monitor-2', type: 'MONITOR', col: 8, row: 6 },
  ];
  return layout;
}

describe('work-seat selection', () => {
  beforeEach(() => {
    installTestCatalog();
  });

  it('addAgent prefers a free work seat over free rest seats', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    expect(ch.seatId).not.toBeNull();
    expect(os.seats.get(ch.seatId!)!.role).toBe('work');
  });

  it('falls back to a rest seat when no work seat exists (computer-less layout)', () => {
    const os = new OfficeState(layoutWithOnlyRestSeats());
    os.addAgent(1);
    expect(os.characters.get(1)!.seatId).not.toBeNull();
  });

  it('returns seatless only when every seat is occupied', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    // 3 seats total: 1 work (chair-1) + 2 rest (couch-1, couch-1:1).
    os.addAgent(1);
    os.addAgent(2);
    os.addAgent(3);
    expect(os.characters.get(1)!.seatId).not.toBeNull();
    expect(os.characters.get(2)!.seatId).not.toBeNull();
    expect(os.characters.get(3)!.seatId).not.toBeNull();

    os.addAgent(4);
    expect(os.characters.get(4)!.seatId).toBeNull();
    expect(os.characters.get(4)!.preferredSeatId).toBeNull();
  });

  it('reassignSeat records the preference and claims the target', () => {
    const os = new OfficeState(layoutWithTwoWorkSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    const target = [...os.seats.entries()].find(
      ([uid, s]) => s.role === 'work' && uid !== ch.seatId,
    )!;
    os.reassignSeat(1, target[0]);
    expect(ch.preferredSeatId).toBe(target[0]);
    expect(ch.seatId).toBe(target[0]);
    expect(os.seats.get(target[0])!.assigned).toBe(true);
  });

  it('getPersistableSeats persists the preferred seat even while the claim is released', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    const pref = ch.preferredSeatId!;
    os.seats.get(ch.seatId!)!.assigned = false;
    ch.seatId = null;
    expect(os.getPersistableSeats()[1].seatId).toBe(pref);
  });

  it('a restored agent whose preferred chair is taken keeps the preference and stands nearby', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1); // takes the only work seat
    const taken = os.characters.get(1)!.seatId!;
    os.addAgent(2, undefined, undefined, taken, true);
    const ch = os.characters.get(2)!;
    expect(ch.preferredSeatId).toBe(taken);
    expect(ch.seatId).toBeNull();
    expect(ch.state).not.toBe(CharacterState.TYPE);
    expect(os.walkableTiles.some((t) => t.col === ch.tileCol && t.row === ch.tileRow)).toBe(true);
  });

  it('sendToSeat on an unclaimed idle agent claims its preferred seat and walks there', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    const pref = ch.preferredSeatId!;
    os.seats.get(pref)!.assigned = false;
    ch.seatId = null;
    ch.tileCol = 0;
    ch.tileRow = 0;
    os.sendToSeat(1);
    expect(ch.seatId).toBe(pref);
    expect(os.seats.get(pref)!.assigned).toBe(true);
  });

  it('reassignSeat to a rest seat is a no-op', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    const originalSeatId = ch.seatId!;
    expect(os.seats.get(originalSeatId)!.role).toBe('work');

    os.reassignSeat(1, 'couch-1');

    expect(ch.seatId).toBe(originalSeatId);
    expect(os.seats.get('couch-1')!.assigned).toBe(false);
    // A true no-op must not free the agent's current seat either — otherwise
    // the next addAgent could double-book it.
    expect(os.seats.get(originalSeatId)!.assigned).toBe(true);
  });

  it('preferredSeatId pointing at a rest seat is ignored', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats());
    // Work seat (chair-1) is free; ask for a rest seat by uid — must fall
    // through to findFreeSeat instead of honoring the preference.
    os.addAgent(2, undefined, undefined, 'couch-1');
    const ch = os.characters.get(2)!;
    expect(ch.seatId).not.toBe('couch-1');
  });
});
