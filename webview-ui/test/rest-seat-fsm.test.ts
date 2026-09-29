/**
 * Rest-seat FSM (Task 3 of the m1.5 character-behaviors slice). Idle
 * characters wander then claim the nearest free REST seat (couch); active or
 * awaiting-user characters release any rest claim and walk to their work seat
 * (`seatId`). Drives `updateCharacter` directly with a synthetic seats map and
 * a tiny hand-built tileMap — no OfficeState needed.
 *
 * Run with: npm run test:webview -- test/rest-seat-fsm.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  AWAITING_REST_DELAY_MS,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
} from '../src/constants.js';
import {
  createCharacter,
  findNearestFreeRestSeat,
  isChairTile,
  shouldBeSeated,
  updateCharacter,
} from '../src/office/engine/characters.js';
import { getWalkableTiles } from '../src/office/layout/tileMap.js';
import type { Seat } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

/** All-floor tileMap of the given size — every tile walkable unless a test
 *  overrides individual cells. */
function openTileMap(cols: number, rows: number): TileType[][] {
  return Array.from({ length: rows }, () => new Array<TileType>(cols).fill(TileType.FLOOR_1));
}

function makeSeat(
  uid: string,
  seatCol: number,
  seatRow: number,
  role: 'work' | 'rest',
  assigned = false,
  facingDir: Direction = Direction.DOWN,
): Seat {
  return { uid, seatCol, seatRow, facingDir, assigned, role };
}

describe('createCharacter', () => {
  it('spawns idle (isActive false)', () => {
    expect(createCharacter(1, 0, null, null).isActive).toBe(false);
  });
});

describe('shouldBeSeated', () => {
  it('is true when active, regardless of awaiting age', () => {
    const ch = createCharacter(1, 0, null, null);
    expect(shouldBeSeated(ch)).toBe(false);
    ch.isActive = true;
    ch.awaitingSince = 1; // ancient — active still wins
    expect(shouldBeSeated(ch, 10_000_000)).toBe(true);
  });

  it('awaiting holds the desk only within AWAITING_REST_DELAY_MS, then releases', () => {
    const ch = createCharacter(1, 0, null, null);
    const now = 1_000_000_000;
    ch.awaitingSince = now - 1000;
    expect(shouldBeSeated(ch, now)).toBe(true);
    ch.awaitingSince = now - AWAITING_REST_DELAY_MS + 1;
    expect(shouldBeSeated(ch, now)).toBe(true);
    ch.awaitingSince = now - AWAITING_REST_DELAY_MS - 1;
    expect(shouldBeSeated(ch, now)).toBe(false);
  });

  it('an expired awaiting latch steps the character off the desk in updateCharacter', () => {
    const tileMap = openTileMap(6, 6);
    const seats = new Map<string, Seat>([['w1', makeSeat('w1', 2, 2, 'work')]]);
    const ch = createCharacter(1, 0, null, null);
    ch.state = CharacterState.TYPE;
    ch.seatId = 'w1';
    ch.tileCol = 2;
    ch.tileRow = 2;
    ch.seatTimer = 0;
    ch.isActive = false;

    const now = 1_000_000_000;
    // Fresh latch: stays typing at the desk.
    ch.awaitingSince = now - 1000;
    updateCharacter(
      ch,
      0.016,
      getWalkableTiles(tileMap, new Set()),
      seats,
      tileMap,
      new Set(),
      now,
    );
    expect(ch.state).toBe(CharacterState.TYPE);

    // Expired latch: releases the desk (IDLE, step-off pause scheduled).
    ch.awaitingSince = now - AWAITING_REST_DELAY_MS - 1;
    updateCharacter(
      ch,
      0.016,
      getWalkableTiles(tileMap, new Set()),
      seats,
      tileMap,
      new Set(),
      now,
    );
    expect(ch.state).toBe(CharacterState.IDLE);
  });
});

describe('isChairTile', () => {
  it('is true for any seat tile (work or rest), false elsewhere', () => {
    const seats = new Map<string, Seat>([
      ['work-1', makeSeat('work-1', 2, 2, 'work')],
      ['rest-1', makeSeat('rest-1', 5, 5, 'rest')],
    ]);
    expect(isChairTile(2, 2, seats)).toBe(true);
    expect(isChairTile(5, 5, seats)).toBe(true);
    expect(isChairTile(0, 0, seats)).toBe(false);
  });
});

describe('findNearestFreeRestSeat', () => {
  it('picks nearest free rest seat, skips work and assigned', () => {
    const ch = createCharacter(1, 0, null, null); // tileCol=1, tileRow=1
    const seats = new Map<string, Seat>([
      ['work-1', makeSeat('work-1', 1, 2, 'work')], // distance 1 but work — skip
      ['rest-assigned', makeSeat('rest-assigned', 1, 0, 'rest', true)], // distance 1 but assigned — skip
      ['rest-far', makeSeat('rest-far', 4, 4, 'rest')], // distance 6
      ['rest-near', makeSeat('rest-near', 2, 1, 'rest')], // distance 1, free — nearest match
    ]);
    expect(findNearestFreeRestSeat(ch, seats)).toBe('rest-near');
  });
});

describe('updateCharacter — rest-seat FSM', () => {
  it('wanderLimit reached → claims rest seat and walks to it', () => {
    const tileMap = openTileMap(5, 5);
    const workSeat = makeSeat('work-1', 0, 0, 'work');
    const restSeat = makeSeat('rest-1', 3, 1, 'rest'); // Manhattan distance 2 from (1,1)
    const seats = new Map<string, Seat>([
      ['work-1', workSeat],
      ['rest-1', restSeat],
    ]);
    const blockedTiles = new Set<string>(['0,0', '3,1']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(2, 0, null, null); // tileCol=1, tileRow=1
    ch.state = CharacterState.IDLE;
    ch.wanderCount = ch.wanderLimit;
    ch.wanderTimer = 0.05;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);

    expect(ch.restSeatId).toBe('rest-1');
    expect(restSeat.assigned).toBe(true);
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.length).toBeGreaterThan(0);
    // Temporary unblock/reblock leaves blockedTiles exactly as it found it.
    expect(blockedTiles.has('3,1')).toBe(true);
  });

  it('claim rolls back when the rest seat is unreachable', () => {
    const tileMap = openTileMap(5, 5);
    // Wall off the rest seat at the grid corner (4,4): its only two neighbors
    // (3,4) and (4,3) are both walls, so it's unreachable even once unblocked.
    tileMap[3][4] = TileType.WALL; // row 3, col 4
    tileMap[4][3] = TileType.WALL; // row 4, col 3
    const restSeat = makeSeat('rest-iso', 4, 4, 'rest');
    const seats = new Map<string, Seat>([['rest-iso', restSeat]]);
    const blockedTiles = new Set<string>(['4,4']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(3, 0, null, null); // tileCol=1, tileRow=1
    ch.state = CharacterState.IDLE;
    ch.wanderCount = ch.wanderLimit;
    ch.wanderTimer = 0.05;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);

    expect(ch.restSeatId).toBeNull();
    expect(restSeat.assigned).toBe(false);
    // No leaked unblock: the seat tile is blocked again after the failed probe.
    expect(blockedTiles.has('4,4')).toBe(true);
  });

  it('sub-agents never claim rest seats', () => {
    const tileMap = openTileMap(5, 5);
    const restSeat = makeSeat('rest-1', 3, 1, 'rest');
    const seats = new Map<string, Seat>([['rest-1', restSeat]]);
    const blockedTiles = new Set<string>(['3,1']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(4, 0, null, null); // tileCol=1, tileRow=1
    ch.isSubagent = true;
    ch.state = CharacterState.IDLE;
    ch.wanderCount = ch.wanderLimit;
    ch.wanderTimer = 0.05;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);

    expect(ch.restSeatId).toBeNull();
    expect(restSeat.assigned).toBe(false);
  });

  it('work starting while resting releases the couch and walks to the work seat', () => {
    const tileMap = openTileMap(5, 5);
    const workSeat = makeSeat('work-1', 0, 0, 'work', true);
    const restSeat = makeSeat('rest-1', 3, 1, 'rest', true, Direction.RIGHT);
    const seats = new Map<string, Seat>([
      ['work-1', workSeat],
      ['rest-1', restSeat],
    ]);
    // The character's own work seat is temporarily unblocked (as OfficeState's
    // withOwnSeatUnblocked would do); the rest seat it's sitting on stays blocked.
    const blockedTiles = new Set<string>(['3,1']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(5, 0, 'work-1', workSeat);
    ch.tileCol = restSeat.seatCol;
    ch.tileRow = restSeat.seatRow;
    ch.state = CharacterState.TYPE;
    ch.restSeatId = 'rest-1';
    ch.isActive = false;

    // Work starts while resting on the couch.
    ch.isActive = true;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles); // TYPE branch: release couch
    expect(ch.restSeatId).toBeNull();
    expect(restSeat.assigned).toBe(false);
    expect(ch.state).toBe(CharacterState.IDLE);

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles); // IDLE branch: path to work seat
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.length).toBeGreaterThan(0);
  });

  it('a fresh awaitingSince alone keeps the character seated at the work seat', () => {
    const tileMap = openTileMap(5, 5);
    const workSeat = makeSeat('work-1', 2, 2, 'work', true);
    const seats = new Map<string, Seat>([['work-1', workSeat]]);
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(6, 0, 'work-1', workSeat);
    ch.state = CharacterState.TYPE;
    ch.isActive = false;
    const now = 1_000_000_000;
    ch.awaitingSince = now; // fresh latch — inside the desk-hold window
    ch.seatTimer = 0;

    for (let i = 0; i < 50; i++) {
      updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles, now + i);
      expect(ch.state).toBe(CharacterState.TYPE);
    }
  });

  it('rest seat lost mid-travel → releases claim and goes IDLE', () => {
    const tileMap = openTileMap(5, 5);
    const restSeat = makeSeat('rest-1', 3, 1, 'rest', true);
    const seats = new Map<string, Seat>([['rest-1', restSeat]]);
    const blockedTiles = new Set<string>(['3,1']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(7, 0, null, null); // tileCol=1, tileRow=1
    ch.state = CharacterState.WALK;
    ch.restSeatId = 'rest-1';
    ch.path = [
      { col: 2, row: 1 },
      { col: 3, row: 1 },
    ];

    // dt=1 with WALK_SPEED_PX_PER_SEC=48 / TILE_SIZE=16 moves exactly one tile per call.
    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles); // -> (2,1), path=[{3,1}]
    expect(ch.tileCol).toBe(2);
    expect(ch.path.length).toBe(1);

    // Seat removed from the map mid-travel (e.g. furniture deleted via layout edit).
    seats.delete('rest-1');

    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles); // -> (3,1), path=[]
    expect(ch.tileCol).toBe(3);
    expect(ch.path.length).toBe(0);

    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles); // arrival: no seat found
    expect(ch.restSeatId).toBeNull();
    expect(ch.state).toBe(CharacterState.IDLE);
  });

  // ── Task 4 addendum: rest-seat arrival, staying put, and mid-walk release ──

  it('rest-seat arrival: sits facing the seat and resets wander state', () => {
    const tileMap = openTileMap(5, 5);
    const restSeat = makeSeat('rest-1', 3, 1, 'rest', true, Direction.RIGHT);
    const seats = new Map<string, Seat>([['rest-1', restSeat]]);
    const blockedTiles = new Set<string>(['3,1']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(8, 0, null, null); // tileCol=1, tileRow=1
    ch.state = CharacterState.WALK;
    ch.restSeatId = 'rest-1';
    ch.wanderCount = 5;
    // Deliberately outside [WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX]
    // so the post-arrival in-range assertion below can only pass if the
    // re-roll at characters.ts:300 actually ran (an in-range seed like 5
    // wouldn't discriminate — it'd pass whether or not the re-roll fired).
    ch.wanderLimit = 999;
    ch.path = [
      { col: 2, row: 1 },
      { col: 3, row: 1 },
    ];

    // dt=1 with WALK_SPEED_PX_PER_SEC=48 / TILE_SIZE=16 moves exactly one tile per call.
    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles); // -> (2,1), path=[{3,1}]
    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles); // -> (3,1), path=[]
    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles); // arrival: sit on the couch

    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.dir).toBe(Direction.RIGHT);
    expect(ch.wanderCount).toBe(0);
    expect(ch.wanderLimit).toBeGreaterThanOrEqual(WANDER_MOVES_BEFORE_REST_MIN);
    expect(ch.wanderLimit).toBeLessThanOrEqual(WANDER_MOVES_BEFORE_REST_MAX);
  });

  it('stays seated on the couch across many idle ticks (no wander-off)', () => {
    const tileMap = openTileMap(5, 5);
    const restSeat = makeSeat('rest-1', 3, 1, 'rest', true, Direction.LEFT);
    const seats = new Map<string, Seat>([['rest-1', restSeat]]);
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(9, 0, null, null);
    ch.tileCol = 3;
    ch.tileRow = 1;
    ch.state = CharacterState.TYPE;
    ch.restSeatId = 'rest-1';
    ch.isActive = false;
    ch.awaitingSince = null;
    ch.seatTimer = 0;

    for (let i = 0; i < 50; i++) {
      updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles);
      expect(ch.state).toBe(CharacterState.TYPE);
    }
  });

  it('flipping active mid-walk releases a claimed rest seat and repaths to the work seat', () => {
    const tileMap = openTileMap(5, 5);
    const workSeat = makeSeat('work-1', 0, 0, 'work');
    const restSeat = makeSeat('rest-1', 3, 1, 'rest', true, Direction.RIGHT);
    const seats = new Map<string, Seat>([
      ['work-1', workSeat],
      ['rest-1', restSeat],
    ]);
    // The character's own work seat is temporarily unblocked (as OfficeState's
    // withOwnSeatUnblocked would do); the claimed rest seat it's walking away
    // from stays blocked.
    const blockedTiles = new Set<string>(['3,1']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(10, 0, 'work-1', workSeat);
    ch.tileCol = 1;
    ch.tileRow = 1;
    ch.state = CharacterState.WALK;
    ch.restSeatId = 'rest-1';
    // Work starts mid-walk (still heading toward the couch at (3,1), not the work seat).
    ch.isActive = true;
    ch.path = [
      { col: 2, row: 1 },
      { col: 3, row: 1 },
    ];

    updateCharacter(ch, 1, walkableTiles, seats, tileMap, blockedTiles);

    expect(restSeat.assigned).toBe(false);
    expect(ch.restSeatId).toBeNull();
  });
});

describe('updateCharacter — claimed work seats', () => {
  it('an idle character releases its claimed seat when it walks away to wander', () => {
    const tileMap = openTileMap(5, 5);
    const workSeat = makeSeat('work-1', 2, 2, 'work', true);
    const seats = new Map<string, Seat>([['work-1', workSeat]]);
    const blockedTiles = new Set<string>(['2,2']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(1, 0, 'work-1', workSeat); // spawned on its seat
    ch.state = CharacterState.IDLE; // stepped off already
    ch.wanderTimer = 0.05;
    ch.wanderCount = 0;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);

    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.seatId).toBeNull();
    expect(workSeat.assigned).toBe(false);
    expect(ch.preferredSeatId).toBe('work-1');
  });

  it('a seatless AGENT that should be seated never enters TYPE: it walks to its waiting spot', () => {
    const tileMap = openTileMap(5, 5);
    const seats = new Map<string, Seat>();
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(1, 0, null, null); // (1,1)
    ch.state = CharacterState.IDLE;
    ch.isActive = true;
    ch.seatWait = true;
    ch.seatWaitTarget = { col: 3, row: 1, facing: Direction.UP };

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    expect(ch.state).toBe(CharacterState.WALK);
    expect(ch.path.at(-1)).toEqual({ col: 3, row: 1 });
  });

  it('at its waiting spot an agent stands IDLE facing the desk and does not re-path', () => {
    const tileMap = openTileMap(5, 5);
    const seats = new Map<string, Seat>();
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(1, 0, null, null);
    ch.state = CharacterState.IDLE;
    ch.isActive = true;
    ch.seatWait = true;
    ch.seatWaitTarget = { col: 1, row: 1, facing: Direction.LEFT }; // already here
    ch.wanderTimer = 0; // would wander if the wait were ignored

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    expect(ch.state).toBe(CharacterState.IDLE);
    expect(ch.path).toHaveLength(0);
    expect(ch.dir).toBe(Direction.LEFT);
  });

  it('an AGENT found in TYPE with no seat and no couch steps to IDLE (never types on the floor)', () => {
    const tileMap = openTileMap(5, 5);
    const seats = new Map<string, Seat>();
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(1, 0, null, null); // createCharacter starts in TYPE
    ch.isActive = true;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    expect(ch.state).toBe(CharacterState.IDLE);
  });

  it('a seatless SUB-AGENT still types in place', () => {
    const tileMap = openTileMap(5, 5);
    const seats = new Map<string, Seat>();
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(-1, 0, null, null);
    ch.isSubagent = true;
    ch.state = CharacterState.IDLE;
    ch.isActive = true;

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    expect(ch.state).toBe(CharacterState.TYPE);
  });

  it('an unreachable claimed seat is released and the agent waits instead of typing on the floor', () => {
    const tileMap = openTileMap(5, 5);
    const workSeat = makeSeat('work-1', 4, 4, 'work', true);
    const seats = new Map<string, Seat>([['work-1', workSeat]]);
    // Wall the seat off: its only neighbours are blocked.
    const blockedTiles = new Set<string>(['4,4', '3,4', '4,3']);
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(1, 0, null, null); // (1,1)
    ch.state = CharacterState.IDLE;
    ch.isActive = true;
    ch.seatId = 'work-1'; // OfficeState just claimed it for us

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    expect(ch.state).not.toBe(CharacterState.TYPE);
    expect(ch.seatId).toBeNull();
    expect(workSeat.assigned).toBe(false);
    expect(ch.seatWait).toBe(true);
  });

  it('arriving somewhere with no claim leaves an agent IDLE, not TYPE', () => {
    const tileMap = openTileMap(5, 5);
    const seats = new Map<string, Seat>();
    const blockedTiles = new Set<string>();
    const walkableTiles = getWalkableTiles(tileMap, blockedTiles);

    const ch = createCharacter(1, 0, null, null);
    ch.isActive = true;
    ch.state = CharacterState.WALK;
    ch.path = []; // arrival tick

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles);
    expect(ch.state).toBe(CharacterState.IDLE);
  });
});
