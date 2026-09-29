/**
 * OfficeState's pre-tick seat step: an agent that should be seated and holds
 * no claim takes a seat through `claimWorkSeat` (checked for reachability),
 * or waits standing at the free tile nearest the nearest desk; an agent that
 * stops needing a seat drops its wait. Sub-agents are never touched.
 *
 * Construction mirrors work-seat-selection.test.ts (a synthetic OfficeLayout
 * fed straight to `new OfficeState(...)`, with a minimal in-memory catalog).
 *
 * Run with: npm run test:webview -- test/seat-claim-step.test.ts
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

describe('OfficeState pre-tick seat step', () => {
  beforeEach(() => {
    installTestCatalog();
  });

  function tick(os: OfficeState, n = 1) {
    for (let i = 0; i < n; i++) os.update(0.1);
  }

  // skipSpawnEffect: addAgent starts a 0.3 s matrix effect during which
  // update() skips the FSM AND the pre-tick step for that character.
  function spawn(os: OfficeState, id: number) {
    os.addAgent(id, undefined, undefined, undefined, true);
  }

  it('an agent that becomes active with no claim claims the nearest free work seat', () => {
    const os = new OfficeState(layoutWithTwoWorkSeats());
    spawn(os, 1);
    const ch = os.characters.get(1)!;
    const spawnSeat = ch.seatId!;
    // Simulate having wandered off: release, move away.
    os.seats.get(spawnSeat)!.assigned = false;
    ch.seatId = null;
    os.setAgentActive(1, true);
    tick(os);
    expect(ch.seatId).not.toBeNull();
    expect(os.seats.get(ch.seatId!)!.assigned).toBe(true);
    expect(os.seats.get(ch.seatId!)!.role).toBe('work');
  });

  it('two agents becoming active in the same tick never claim the same seat', () => {
    const os = new OfficeState(layoutWithTwoWorkSeats());
    spawn(os, 1);
    spawn(os, 2);
    for (const id of [1, 2]) {
      const ch = os.characters.get(id)!;
      os.seats.get(ch.seatId!)!.assigned = false;
      ch.seatId = null;
      ch.preferredSeatId = null; // no preference — both want "the nearest"
      ch.tileCol = 0;
      ch.tileRow = 0;
      os.setAgentActive(id, true);
    }
    tick(os);
    const a = os.characters.get(1)!.seatId;
    const b = os.characters.get(2)!.seatId;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('with every seat taken, an active agent waits standing by a desk and takes a seat when one frees', () => {
    const os = new OfficeState(layoutWithWorkAndRestSeats()); // 1 work + 2 rest
    spawn(os, 1);
    spawn(os, 2);
    spawn(os, 3);
    spawn(os, 4); // seatless
    const late = os.characters.get(4)!;
    expect(late.seatId).toBeNull();
    os.setAgentActive(4, true);
    tick(os);
    expect(late.seatWait).toBe(true);
    expect(late.seatWaitTarget).not.toBeNull();
    expect(late.state).not.toBe(CharacterState.TYPE);
    // Someone leaves: the waiter claims that seat on the next tick.
    os.removeAgent(1);
    tick(os, 2);
    expect(late.seatId).not.toBeNull();
    expect(late.seatWait).toBe(false);
    expect(late.seatWaitTarget).toBeNull();
  });

  it('work ending while waiting clears the wait and lets the agent wander', () => {
    const os = new OfficeState(layoutWithOnlyRestSeats());
    for (const s of os.seats.values()) s.assigned = true; // nothing free
    spawn(os, 1);
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, true);
    tick(os);
    expect(ch.seatWait).toBe(true);
    os.setAgentActive(1, false);
    tick(os);
    expect(ch.seatWait).toBe(false);
    expect(ch.seatWaitTarget).toBeNull();
  });

  it('an unreachable nearest seat is skipped for the next one, with no claim flicker', () => {
    const os = new OfficeState(layoutWithTwoWorkSeats());
    spawn(os, 1);
    const ch = os.characters.get(1)!;
    const [firstUid, first] = [...os.seats.entries()].find(([, s]) => s.role === 'work')!;
    os.seats.get(ch.seatId!)!.assigned = false;
    ch.seatId = null;
    ch.preferredSeatId = firstUid;
    ch.tileCol = 0;
    ch.tileRow = 0;
    // Wall the first seat's tile off from everything (the character stands elsewhere).
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      os.blockedTiles.add(`${first.seatCol + dc},${first.seatRow + dr}`);
    }
    os.setAgentActive(1, true);
    tick(os);
    expect(ch.seatId).not.toBe(firstUid);
    expect(first.assigned).toBe(false);
    tick(os, 3);
    expect(first.assigned).toBe(false); // never flickers on
  });

  it('sub-agents are skipped by the step', () => {
    const os = new OfficeState(layoutWithTwoWorkSeats());
    spawn(os, 1);
    const subId = os.addSubagent(1, 'tool-1');
    const sub = os.characters.get(subId)!;
    tick(os, 5);
    expect(sub.seatId).toBeNull();
    expect(sub.seatWait).toBe(false);
  });
});
