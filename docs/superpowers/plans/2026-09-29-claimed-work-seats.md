# Claimed Work Seats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Computer (work) seats are claimed while an agent needs one and released when it wanders off, the way sofa (rest) seats already work; an agent that needs a seat takes the nearest free computer, then a free sofa, and otherwise waits standing by a desk. No agent character ever types on the floor.

**Architecture:** `Character.seatId` changes meaning from "owned for life" to "currently claimed"; a new `preferredSeatId` carries the user-assigned / spawn seat and is what gets persisted. Claiming is a pure function (`claimWorkSeat` in `seatPlacement.ts`) driven by a pre-tick step in `OfficeState.update` (which has the area mappings and occupancy the FSM lacks); the FSM in `characters.ts` only walks to the claimed seat, releases on wander-off, and stands at a waiting spot when there is nothing to claim. Sub-agents are untouched.

**Tech Stack:** TypeScript, webview only (`webview-ui/`), Vitest Node runner. No protocol change (`saveAgentSeats` keeps its shape).

**Spec:** `docs/superpowers/specs/2026-09-29-adopted-terminals-and-claimed-seats-design.md` — Part D.

## Global Constraints

- Webview only; `core/` and `server/` untouched. No `enum`; `import type` for type-only imports; `.js` on relative imports.
- Sub-agents (`isSubagent`) never claim seats, never wait for one, and still TYPE in place — CONTEXT.md: "around it, not in a seat".
- Roaming and the desk-hold (`AWAITING_REST_DELAY_MS`) are unchanged. The only new release point is the moment an idle character walks away from its desk.
- A claimed seat is not re-evaluated while held (no seat-hopping).
- `saveAgentSeats` / `existingAgents` keep their wire shape; the persisted `seatId` now means the preferred seat.
- Constants stay in `webview-ui/src/constants.ts`; none are needed for this plan.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

- Two active agents becoming active in the same tick must not claim the same seat — Task 3 tests sequential claims in one `update()`.
- An active agent whose claimed seat becomes unreachable (furniture placed in the corridor) must release it and wait, not type on the floor — Task 2 tests the unreachable-claim fallthrough.
- A waiting agent must not re-path every tick once it stands at its waiting spot — Task 3 tests `path` stays empty after arrival.
- Manual seat assignment on an idle agent must still walk it there and sit it for the idle window, and that seat must be released afterwards like any other — Task 4 tests `reassignSeat` then wander-off release.
- A layout rebuild must not leave an agent's claim pointing at a seat that no longer exists — Task 4 tests rebuild with the preferred chair removed.

---

### Task 1: `preferredSeatId` on the character; `claimWorkSeat` and preferred-aware `anchorTile`

**Files:**

- Modify: `webview-ui/src/office/types.ts` (`Character`: three new fields next to `seatId`)
- Modify: `webview-ui/src/office/engine/characters.ts` (`createCharacter` initialisers; new `releaseWorkSeat`)
- Modify: `webview-ui/src/office/engine/seatPlacement.ts` (`AnchorLike`, `anchorTile`, new `claimWorkSeat`)
- Test: `webview-ui/test/work-seat-claim.test.ts` (new)

**Interfaces:**

- Produces (types):

```ts
/** The seat the user assigned (or the spawn seat). Persisted as `seatId`
 *  in saveAgentSeats. Never blocks anything by itself. */
preferredSeatId: string | null;
/** Wants a work seat, none is free: standing by a desk until one frees. */
seatWait: boolean;
/** Where to stand while waiting, and which way to face (toward the seat). */
seatWaitTarget: { col: number; row: number; facing: Direction } | null;
```

- Produces (seatPlacement):

```ts
export interface ClaimLike {
  tileCol: number;
  tileRow: number;
  preferredSeatId: string | null;
}
export function claimWorkSeat(
  ch: ClaimLike,
  seats: ReadonlyMap<string, SeatLike>,
  zoneOf: (uid: string) => string | null,
  areaLabels?: string[],
): string | null;
// AnchorLike gains `preferredSeatId?: string | null`; anchorTile prefers seatId, then preferredSeatId, then the tile.
```

- Produces (characters): `export function releaseWorkSeat(ch: Character, seats: Map<string, Seat>): void` — frees `seats.get(ch.seatId)` and nulls `ch.seatId`; no-op when unclaimed.

- [ ] **Step 1: Write the failing tests**

`webview-ui/test/work-seat-claim.test.ts`:

```ts
/**
 * `claimWorkSeat`: the seat an agent takes when it needs one — preferred
 * seat first, then the nearest free work seat (in-area → unzoned → any),
 * then the nearest free rest seat, else null. Pure, no OfficeState.
 *
 * Run with: npm run test:webview -- test/work-seat-claim.test.ts
 */
import { describe, expect, it } from 'vitest';

import { createCharacter, releaseWorkSeat } from '../src/office/engine/characters.js';
import type { SeatLike } from '../src/office/engine/seatPlacement.js';
import { anchorTile, claimWorkSeat, closestFreeSeat } from '../src/office/engine/seatPlacement.js';
import type { Seat } from '../src/office/types.js';
import { Direction } from '../src/office/types.js';

function seat(
  seatCol: number,
  seatRow: number,
  role: 'work' | 'rest' = 'work',
  assigned = false,
): SeatLike {
  return { seatCol, seatRow, assigned, role };
}

const noZone = () => null;
const at = (tileCol: number, tileRow: number, preferredSeatId: string | null = null) => ({
  tileCol,
  tileRow,
  preferredSeatId,
});

describe('claimWorkSeat', () => {
  it('takes the preferred seat when it is a free work seat, even if farther', () => {
    const seats = new Map<string, SeatLike>([
      ['near', seat(1, 0)],
      ['pref', seat(9, 9)],
    ]);
    expect(claimWorkSeat(at(0, 0, 'pref'), seats, noZone)).toBe('pref');
  });

  it('ignores a preferred seat that is taken or a rest seat', () => {
    const seats = new Map<string, SeatLike>([
      ['near', seat(1, 0)],
      ['taken', seat(2, 0, 'work', true)],
      ['couch', seat(3, 0, 'rest')],
    ]);
    expect(claimWorkSeat(at(0, 0, 'taken'), seats, noZone)).toBe('near');
    expect(claimWorkSeat(at(0, 0, 'couch'), seats, noZone)).toBe('near');
  });

  it('picks the nearest free work seat by Manhattan distance', () => {
    const seats = new Map<string, SeatLike>([
      ['far', seat(5, 5)],
      ['near', seat(1, 2)],
      ['nearTaken', seat(0, 1, 'work', true)],
    ]);
    expect(claimWorkSeat(at(0, 0), seats, noZone)).toBe('near');
  });

  it('prefers a work seat in one of the folder areas, then unzoned, then any', () => {
    const seats = new Map<string, SeatLike>([
      ['inArea', seat(6, 0)],
      ['unzoned', seat(1, 0)],
      ['otherArea', seat(0, 1)],
    ]);
    const zoneOf = (uid: string) =>
      uid === 'inArea' ? 'Backend' : uid === 'otherArea' ? 'Design' : null;
    expect(claimWorkSeat(at(0, 0), seats, zoneOf, ['Backend'])).toBe('inArea');
    expect(claimWorkSeat(at(0, 0), seats, zoneOf, ['Nowhere'])).toBe('unzoned');
    const onlyZoned = new Map<string, SeatLike>([['otherArea', seat(0, 1)]]);
    expect(claimWorkSeat(at(0, 0), onlyZoned, zoneOf, ['Backend'])).toBe('otherArea');
  });

  it('falls back to the nearest free rest seat when every work seat is taken', () => {
    const seats = new Map<string, SeatLike>([
      ['work', seat(1, 0, 'work', true)],
      ['couchFar', seat(6, 6, 'rest')],
      ['couchNear', seat(0, 2, 'rest')],
    ]);
    expect(claimWorkSeat(at(0, 0), seats, noZone)).toBe('couchNear');
  });

  it('skips excluded seats (an unreachable claim is retried without it)', () => {
    const seats = new Map<string, SeatLike>([
      ['near', seat(1, 0)],
      ['next', seat(2, 0)],
    ]);
    expect(claimWorkSeat(at(0, 0, 'near'), seats, noZone, undefined, new Set(['near']))).toBe(
      'next',
    );
    expect(claimWorkSeat(at(0, 0), seats, noZone, undefined, new Set(['near', 'next']))).toBeNull();
  });

  it('closestFreeSeat never returns the excluded uid', () => {
    const seats = new Map<string, SeatLike>([
      ['leadPref', seat(5, 5)], // released by the idle lead: free, distance 0
      ['beside', seat(6, 5)],
    ]);
    expect(closestFreeSeat(seats, 5, 5, 'leadPref')).toBe('beside');
    expect(closestFreeSeat(seats, 5, 5)).toBe('leadPref');
  });

  it('returns null when nothing is free', () => {
    const seats = new Map<string, SeatLike>([
      ['work', seat(1, 0, 'work', true)],
      ['couch', seat(0, 2, 'rest', true)],
    ]);
    expect(claimWorkSeat(at(0, 0), seats, noZone)).toBeNull();
  });
});

describe('anchorTile with a preferred seat', () => {
  it('uses the claimed seat, else the preferred seat, else the live tile', () => {
    const seats = new Map<string, SeatLike>([
      ['claimed', seat(3, 3, 'work', true)],
      ['pref', seat(7, 7)],
    ]);
    expect(
      anchorTile({ seatId: 'claimed', preferredSeatId: 'pref', tileCol: 0, tileRow: 0 }, seats),
    ).toEqual({ col: 3, row: 3 });
    expect(
      anchorTile({ seatId: null, preferredSeatId: 'pref', tileCol: 0, tileRow: 0 }, seats),
    ).toEqual({ col: 7, row: 7 });
    expect(
      anchorTile({ seatId: null, preferredSeatId: null, tileCol: 1, tileRow: 2 }, seats),
    ).toEqual({ col: 1, row: 2 });
  });
});

describe('createCharacter + releaseWorkSeat', () => {
  it('spawn seat becomes both the claim and the preference; release keeps the preference', () => {
    const s: Seat = {
      uid: 'w',
      seatCol: 2,
      seatRow: 2,
      facingDir: Direction.UP,
      assigned: true,
      role: 'work',
    };
    const seats = new Map<string, Seat>([['w', s]]);
    const ch = createCharacter(1, 0, 'w', s);
    expect(ch.seatId).toBe('w');
    expect(ch.preferredSeatId).toBe('w');
    expect(ch.seatWait).toBe(false);
    expect(ch.seatWaitTarget).toBeNull();
    releaseWorkSeat(ch, seats);
    expect(ch.seatId).toBeNull();
    expect(s.assigned).toBe(false);
    expect(ch.preferredSeatId).toBe('w');
    releaseWorkSeat(ch, seats); // idempotent
    expect(s.assigned).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd webview-ui && npx vitest run test/work-seat-claim.test.ts`
Expected: FAIL — `claimWorkSeat` / `releaseWorkSeat` not exported; `preferredSeatId` undefined.

- [ ] **Step 3: Types**

`webview-ui/src/office/types.ts`, in `Character` right after the `seatId` field's doc + declaration:

```ts
  /** The seat the user assigned (or the spawn seat). Persisted as `seatId` in
   *  saveAgentSeats. Never blocks anything by itself — `seatId` is the CLAIM. */
  preferredSeatId: string | null;
  /** Wants a work seat and none is free: standing by a desk until one frees. */
  seatWait: boolean;
  /** Where to stand while waiting, facing the desk it waits for. */
  seatWaitTarget: { col: number; row: number; facing: Direction } | null;
```

and change the `seatId` doc comment to `/** Currently CLAIMED seat uid (work seat, or a rest seat when the office is oversubscribed), or null. Claimed when the character needs a seat, released when it walks away. */`.

- [ ] **Step 4: `createCharacter` and `releaseWorkSeat`**

In `createCharacter`, after `seatId,` add `preferredSeatId: seatId, seatWait: false, seatWaitTarget: null,`. Add next to `findNearestFreeRestSeat`:

```ts
/** Free the character's claimed seat (work or fallback rest), keeping its
 *  preference. No-op when nothing is claimed. */
export function releaseWorkSeat(ch: Character, seats: Map<string, Seat>): void {
  if (!ch.seatId) return;
  const seat = seats.get(ch.seatId);
  if (seat) seat.assigned = false;
  ch.seatId = null;
}
```

- [ ] **Step 5: `seatPlacement.ts`**

```ts
export interface AnchorLike {
  seatId: string | null;
  preferredSeatId?: string | null;
  tileCol: number;
  tileRow: number;
}

export function anchorTile(
  anchor: AnchorLike | undefined,
  seats: ReadonlyMap<string, SeatLike>,
): { col: number; row: number } | undefined {
  if (!anchor) return undefined;
  const uid = anchor.seatId ?? anchor.preferredSeatId ?? null;
  const seat = uid ? seats.get(uid) : undefined;
  return seat
    ? { col: seat.seatCol, row: seat.seatRow }
    : { col: anchor.tileCol, row: anchor.tileRow };
}

export interface ClaimLike {
  tileCol: number;
  tileRow: number;
  preferredSeatId: string | null;
}

/** Nearest free seat matching `keep`, by Manhattan distance from the tile. */
function nearestFreeWhere(
  seats: ReadonlyMap<string, SeatLike>,
  col: number,
  row: number,
  keep: (uid: string, seat: SeatLike) => boolean,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const [uid, seat] of seats) {
    if (seat.assigned || !keep(uid, seat)) continue;
    const d = Math.abs(seat.seatCol - col) + Math.abs(seat.seatRow - row);
    if (d < bestDist) {
      best = uid;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The seat a character claims when it needs one: its preferred seat when that
 * is a free work seat; else the nearest free work seat inside one of its
 * folder's areas, then the nearest unzoned one, then any; else the nearest
 * free rest seat (the office is oversubscribed — working on the sofa beats
 * standing); else null. Mirrors findFreeSeat's area stages with proximity in
 * place of random choice.
 */
export function claimWorkSeat(
  ch: ClaimLike,
  seats: ReadonlyMap<string, SeatLike>,
  zoneOf: (uid: string) => string | null,
  areaLabels?: string[],
  exclude?: ReadonlySet<string>,
): string | null {
  const ok = (uid: string, s: SeatLike) => !s.assigned && !exclude?.has(uid);
  if (ch.preferredSeatId) {
    const pref = seats.get(ch.preferredSeatId);
    if (pref && pref.role === 'work' && ok(ch.preferredSeatId, pref)) return ch.preferredSeatId;
  }
  const { tileCol: col, tileRow: row } = ch;
  if (areaLabels && areaLabels.length > 0) {
    const wanted = new Set(areaLabels);
    const inArea = nearestFreeWhere(seats, col, row, (uid, s) => {
      if (s.role !== 'work' || !ok(uid, s)) return false;
      const z = zoneOf(uid);
      return z !== null && wanted.has(z);
    });
    if (inArea) return inArea;
  }
  return (
    nearestFreeWhere(
      seats,
      col,
      row,
      (uid, s) => s.role === 'work' && ok(uid, s) && zoneOf(uid) === null,
    ) ??
    nearestFreeWhere(seats, col, row, (uid, s) => s.role === 'work' && ok(uid, s)) ??
    nearestFreeWhere(seats, col, row, (uid, s) => s.role === 'rest' && ok(uid, s))
  );
}
```

Rewrite the existing private `nearestFree(seats, col, row, workOnly)` as a call to `nearestFreeWhere` so `closestFreeSeat` keeps its behaviour with one implementation, and give `closestFreeSeat` an optional fourth parameter `exclude?: string | null` (a uid never returned): the lead's own preferred seat must not be handed to a teammate just because the lead released it while idle.

- [ ] **Step 6: Run the new test, the placement tests, and types**

Run: `cd webview-ui && npx vitest run test/work-seat-claim.test.ts test/teammateSeating.test.ts && npx tsc -b`
Expected: PASS; tsc reports errors ONLY in files that build `Character` literals without the three new fields — today that is `webview-ui/test/petEntity.test.ts` — fix each by adding `preferredSeatId: null, seatWait: false, seatWaitTarget: null` (or by routing through `createCharacter`). Run `npx tsc -b` again until clean.

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/types.ts webview-ui/src/office/engine/characters.ts webview-ui/src/office/engine/seatPlacement.ts webview-ui/test/work-seat-claim.test.ts
git commit -m "feat(webview): preferred vs claimed seat model; claimWorkSeat picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Include any test fixture files tsc made you touch.)

---

### Task 2: FSM — walk to the claim, release on wander-off, wait standing when seatless

**Files:**

- Modify: `webview-ui/src/office/engine/characters.ts` (`updateCharacter`: IDLE and WALK branches)
- Test: `webview-ui/test/rest-seat-fsm.test.ts` (append a describe block; uses its `openTileMap`, `makeSeat`)

**Interfaces:**

- Consumes: Task 1's `releaseWorkSeat`, `seatWait`, `seatWaitTarget`.
- Produces: FSM behaviour only. `OfficeState` (Task 3) sets `seatId`/`seatWait`/`seatWaitTarget` before each tick; the FSM never claims.

- [ ] **Step 1: Write the failing tests**

Append to `rest-seat-fsm.test.ts` (imports: add `releaseWorkSeat` to the characters import; `Direction` is already imported):

```ts
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
```

Also, in the existing `it('claim rolls back when the rest seat is unreachable'` etc., nothing changes. Task 1 already covers `releaseWorkSeat` directly; here `releaseWorkSeat` is only imported if a test needs it — drop the import if unused.

- [ ] **Step 2: Run to verify failure**

Run: `cd webview-ui && npx vitest run test/rest-seat-fsm.test.ts -t "claimed work seats"`
Expected: FAIL — first test keeps `seatId`; seatless agent enters TYPE; unreachable claim enters TYPE.

- [ ] **Step 3: Implement the FSM changes**

In `updateCharacter`, IDLE branch, replace the block

```ts
      if (shouldBeSeated(ch, now)) {
        if (ch.restSeatId) { … release … }
        if (!ch.seatId) {
          ch.state = CharacterState.TYPE;
          ch.frame = 0;
          ch.frameTimer = 0;
          break;
        }
        const seat = seats.get(ch.seatId);
        if (seat) {
          const path = findPath(…);
          if (path.length > 0) { … WALK … } else { … TYPE … }
        }
        break;
      }
```

with

```ts
if (shouldBeSeated(ch, now)) {
  if (ch.restSeatId) {
    const rest = seats.get(ch.restSeatId);
    if (rest) rest.assigned = false;
    ch.restSeatId = null;
  }
  if (!ch.seatId) {
    if (ch.isSubagent) {
      // Sub-agents work beside their parent, never in a seat.
      ch.state = CharacterState.TYPE;
      ch.frame = 0;
      ch.frameTimer = 0;
      break;
    }
    // An agent with nothing to claim (OfficeState's pre-tick step sets
    // seatWait/seatWaitTarget): walk to the waiting spot, then stand
    // there facing the desk. Never TYPE without a seat.
    const target = ch.seatWaitTarget;
    if (target && (ch.tileCol !== target.col || ch.tileRow !== target.row)) {
      const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles);
      if (path.length > 0) {
        ch.path = path;
        ch.moveProgress = 0;
        ch.state = CharacterState.WALK;
        ch.frame = 0;
        ch.frameTimer = 0;
      }
    } else if (target) {
      ch.dir = target.facing;
    }
    break;
  }
  const seat = seats.get(ch.seatId);
  if (seat) {
    const atSeat = ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow;
    const path = atSeat
      ? []
      : findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles);
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else if (atSeat) {
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else if (!ch.isSubagent) {
      // Claimed but unreachable (furniture in the corridor): give it
      // back and wait; the pre-tick step retries next tick.
      releaseWorkSeat(ch, seats);
      ch.seatWait = true;
    }
  }
  break;
}
```

Directly after that block, at the start of the wander logic (`ch.wanderTimer -= dt; if (ch.wanderTimer <= 0) {`), add as the first statement inside the `if`:

```ts
// Walking away from the desk is the release point: an idle agent's
// computer goes back to the pool the moment it leaves (rest seats
// are claimed separately below).
releaseWorkSeat(ch, seats);
```

At the very top of the TYPE branch (before the frame animation), add:

```ts
// An agent character can only TYPE on a claimed seat or a claimed couch.
// createCharacter starts in TYPE and a seatless spawn/restore would
// otherwise type on the floor forever.
if (!ch.isSubagent && !ch.seatId && !ch.restSeatId) {
  ch.state = CharacterState.IDLE;
  ch.frame = 0;
  ch.frameTimer = 0;
  break;
}
```

In the WALK branch's arrival block, replace

```ts
        if (shouldBeSeated(ch, now)) {
          if (!ch.seatId) {
            ch.state = CharacterState.TYPE;
          } else {
```

with

```ts
        if (shouldBeSeated(ch, now)) {
          if (!ch.seatId) {
            // Sub-agents type where they stand; an agent waits (IDLE handles
            // the waiting spot next tick).
            ch.state = ch.isSubagent ? CharacterState.TYPE : CharacterState.IDLE;
          } else {
```

`findPath` and `releaseWorkSeat` are both in this file already.

- [ ] **Step 4: Run the whole FSM file**

Run: `cd webview-ui && npx vitest run test/rest-seat-fsm.test.ts`
Expected: PASS. If `'a fresh awaitingSince alone keeps the character seated at the work seat'` fails, it is because its character was created without a claim: read it — it must construct the character with `createCharacter(id, palette, 'work-1', workSeat)` (claim + preference); adjust only the fixture, not the assertion.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/characters.ts webview-ui/test/rest-seat-fsm.test.ts
git commit -m "feat(webview): FSM walks to the claimed seat, releases on wander-off, waits standing when seatless

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: OfficeState pre-tick seat step and waiting spot

**Files:**

- Modify: `webview-ui/src/office/engine/officeState.ts` (`update`, new `seatClaimStep`, `waitingSpot`, `isValidWaitTarget`; `closestFreeWalkableTile` gets an `exceptId`)
- Test: `webview-ui/test/seat-claim-step.test.ts` (new; copy `installTestCatalog()` and the layout builders from `work-seat-selection.test.ts` verbatim — they are module-private there)

**Interfaces:**

- Consumes: Task 1 `claimWorkSeat`; Task 2 FSM semantics; `shouldBeSeated` (exported from characters.ts); `isWalkable` from `../layout/tileMap.js`.
- Produces: `OfficeState.update` claims before ticking; `Character.seatWaitTarget` is set/refreshed here only.

- [ ] **Step 1: Write the failing tests**

`webview-ui/test/seat-claim-step.test.ts` (top: the copied `installTestCatalog`, `layoutWithWorkAndRestSeats`, `layoutWithOnlyRestSeats` from `work-seat-selection.test.ts`, plus a `layoutWithTwoWorkSeats()` built the same way with two chair+desk+monitor triples). Then:

```ts
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
    os.addSubagent(1, 'tool-1', 'Subtask: x');
    const subId = os.getSubagentId(1, 'tool-1')!;
    const sub = os.characters.get(subId)!;
    tick(os, 3);
    expect(sub.seatId).toBeNull();
    expect(sub.seatWait).toBe(false);
  });
});
```

(`os.addSubagent`'s exact signature: read it in `officeState.ts` and match; `rest-seat-officestate.test.ts` calls it — copy that call.)

- [ ] **Step 2: Run to verify failure**

Run: `cd webview-ui && npx vitest run test/seat-claim-step.test.ts`
Expected: FAIL — no claim happens in `update`; `seatWait` never set.

- [ ] **Step 3: Implement**

In `officeState.ts`:

1. Imports: add `claimWorkSeat` to the `seatPlacement.js` import; add `shouldBeSeated` to the `characters.js` import; ensure `isWalkable` and `findPath` are imported from `../layout/tileMap.js` (both already are — `walkToTile` and `reassignSeat` use them).

2. `closestFreeWalkableTile(col, row, exceptId?: number)`: skip `ch.id === exceptId` when building `occupied`.

3. New private methods (place after `withOwnSeatUnblocked`):

```ts
  /** Tile a seatless agent waits on: the free walkable tile nearest to the
   *  nearest work seat, facing that seat. Null when the layout has no work
   *  seats or no free tile. */
  private waitingSpot(ch: Character): { col: number; row: number; facing: Direction } | null {
    let nearest: Seat | null = null;
    let nearestDist = Infinity;
    for (const seat of this.seats.values()) {
      if (seat.role !== 'work') continue;
      const d = Math.abs(seat.seatCol - ch.tileCol) + Math.abs(seat.seatRow - ch.tileRow);
      if (d < nearestDist) {
        nearest = seat;
        nearestDist = d;
      }
    }
    if (!nearest) return null;
    // Two waiters may be handed the same spot; isValidWaitTarget (occupied by
    // another character) makes the second one re-pick after the first arrives.
    const tile = this.closestFreeWalkableTile(nearest.seatCol, nearest.seatRow, ch.id);
    return tile ? { col: tile.col, row: tile.row, facing: nearest.facingDir } : null;
  }

  private isValidWaitTarget(ch: Character): boolean {
    const t = ch.seatWaitTarget;
    if (!t) return false;
    if (!isWalkable(t.col, t.row, this.tileMap, this.blockedTiles)) return false;
    for (const other of this.characters.values()) {
      if (other.id !== ch.id && other.tileCol === t.col && other.tileRow === t.row) return false;
    }
    return true;
  }

  /** Pre-tick seat bookkeeping for agent characters (never sub-agents): an
   *  agent that should be seated and holds no claim takes a seat via
   *  claimWorkSeat, or waits at the waiting spot; an agent that stopped
   *  needing a seat drops its wait. The FSM (updateCharacter) only walks. */
  private seatClaimStep(ch: Character, now: number): void {
    if (shouldBeSeated(ch, now)) {
      if (ch.seatId) return;
      const areaLabels = ch.folderName ? this.areaMappings[ch.folderName] : undefined;
      // Reachability is checked HERE, retrying without unreachable candidates:
      // if the FSM alone rolled back an unreachable claim, the next step would
      // hand it the same nearest seat every tick (BFS + assigned flicker).
      const skip = new Set<string>();
      for (;;) {
        const uid = claimWorkSeat(ch, this.seats, (u) => this.seatZone(u), areaLabels, skip);
        if (!uid) break;
        const seat = this.seats.get(uid)!;
        const atSeat = ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow;
        const key = `${seat.seatCol},${seat.seatRow}`;
        const wasBlocked = this.blockedTiles.has(key);
        if (wasBlocked) this.blockedTiles.delete(key);
        const reachable =
          atSeat ||
          findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
            .length > 0;
        if (wasBlocked) this.blockedTiles.add(key);
        if (!reachable) {
          skip.add(uid);
          continue;
        }
        seat.assigned = true;
        ch.seatId = uid;
        ch.seatWait = false;
        ch.seatWaitTarget = null;
        return;
      }
      ch.seatWait = true;
      if (!this.isValidWaitTarget(ch)) ch.seatWaitTarget = this.waitingSpot(ch);
    } else if (ch.seatWait) {
      ch.seatWait = false;
      ch.seatWaitTarget = null;
    }
  }
```

4. In `update(dt)`, compute `const now = Date.now();` once before the character loop, and inside the loop right before `this.withOwnSeatUnblocked(ch, () => updateCharacter(...))` add `if (!ch.isSubagent) this.seatClaimStep(ch, now);`. Pass `now` to `updateCharacter` as its last argument so both halves of the tick agree on the time.

- [ ] **Step 4: Run, then the whole webview suite**

Run: `cd webview-ui && npx vitest run test/seat-claim-step.test.ts && npx vitest run`
Expected: the new file passes. Other files may now fail on the OLD model's expectations; Task 4 updates them — note which ones fail here, do not fix them in this task.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts webview-ui/test/seat-claim-step.test.ts
git commit -m "feat(webview): OfficeState claims work seats before each tick; waiting spot when none is free

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: OfficeState consumers — spawn, reassignment, rebuild, persistence, teammates

**Files:**

- Modify: `webview-ui/src/office/engine/officeState.ts` (`addAgent`, `reassignSeat`, `sendToSeat`, `reseatNextToLead`, `rebuildFromLayout`, `removeAgent`, `getPersistableSeats`)
- Test: `webview-ui/test/work-seat-selection.test.ts`, `webview-ui/test/rest-seat-officestate.test.ts` (update + extend)

- [ ] **Step 1: Write / update the failing tests**

In `work-seat-selection.test.ts`, extend `'returns seatless only when every seat is occupied'` with `expect(os.characters.get(4)!.preferredSeatId).toBeNull();` and add:

```ts
it('reassignSeat records the preference and claims the target', () => {
  const os = new OfficeState(layoutWithWorkAndRestSeats());
  os.addAgent(1);
  const ch = os.characters.get(1)!;
  const target = [...os.seats.entries()].find(([uid, s]) => s.role === 'work' && uid !== ch.seatId);
  if (!target) return; // single-work-seat fixture: nothing to reassign to
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
```

In `rest-seat-officestate.test.ts`:

- `'removeAgent frees a claimed rest seat'` stays.
- `'rebuildFromLayout clears every rest claim and frees the seats'`: its agent is IDLE, so after the rebuild `seatId` is `null` and the chair is free; change the `ch.seatId === workSeatId` assertion to `expect(ch.preferredSeatId).toBe(workSeatId); expect(ch.seatId).toBeNull();`.
- Replace `'rebuildFromLayout reseats an agent whose kept chair demoted to rest'` with two cases: (a) an ACTIVE agent (`os.setAgentActive(1, true)` before the rebuild) whose preferred chair demoted to rest claims a free work seat and its `preferredSeatId` becomes null; (b) an IDLE agent whose preferred chair disappeared from the layout ends with `seatId === null`, `preferredSeatId === null`, and stands on a walkable tile (`os.walkableTiles.some(t => t.col === ch.tileCol && t.row === ch.tileRow)`). Keep the fixtures the file already uses for the demotion (remove the monitor) and removal (drop the chair from `furniture`).
- Add: `'rebuild re-claims for agents that should be seated and snaps them to the seat'` — active agent, unchanged layout → after rebuild `seatId` non-null and `tileCol/tileRow` equal the seat's.

- [ ] **Step 2: Run to verify failure**

Run: `cd webview-ui && npx vitest run test/work-seat-selection.test.ts test/rest-seat-officestate.test.ts`
Expected: FAIL on the new/updated cases (`preferredSeatId` handling, `sendToSeat` with no claim, rebuild semantics).

- [ ] **Step 3: Implement**

`officeState.ts`:

- `addAgent`: when `preferredSeatId` names an existing WORK seat that is currently taken (a restore whose chair someone else claimed), keep it as the preference instead of letting `findFreeSeat` pick another chair: create the character seatless (`createCharacter(id, palette, null, null, hueShift)`), set `ch.preferredSeatId = preferredSeatId`, and place it at `closestFreeWalkableTile(seat.seatCol, seat.seatRow)` (fall back to the existing random-walkable spawn when that is null). Otherwise the pick is unchanged (`createCharacter(id, palette, seatId, seat, hueShift)` sets `preferredSeatId`). In BOTH seatless branches set `ch.state = CharacterState.IDLE` — `createCharacter` starts in TYPE, and an agent must never type without a seat.
- `reassignSeat(agentId, seatId)`: after the validation and before assigning, `releaseWorkSeat(ch, this.seats)` replaces the manual "unassign old" lines; then `seat.assigned = true; ch.seatId = seatId; ch.preferredSeatId = seatId;` and the existing pathfinding logic stays — EXCEPT its "no path → sit down" else-branch, which must only sit when `atSeat` (`ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow`); when the seat is unreachable, `releaseWorkSeat(ch, this.seats)` and leave the character IDLE (the preference is kept). Apply the identical `atSeat` rule to `sendToSeat`'s else-branch. (Import `releaseWorkSeat` from `./characters.js`.)
- `sendToSeat(agentId)`: at the top replace `if (!ch || !ch.seatId) return; const seat = this.seats.get(ch.seatId);` with

```ts
if (!ch || ch.isSubagent) return;
if (!ch.seatId) {
  // Unclaimed: take the preferred seat if it is free, else nothing to go to.
  const pref = ch.preferredSeatId ? this.seats.get(ch.preferredSeatId) : undefined;
  if (!pref || pref.assigned || pref.role !== 'work') return;
  pref.assigned = true;
  ch.seatId = ch.preferredSeatId;
}
const seat = this.seats.get(ch.seatId!);
```

- `reseatNextToLead`: `const current = teammate.seatId ?? teammate.preferredSeatId;` replaces `teammate.seatId` in both the `target === …` check and the `currentSeat` lookup; `closestFreeSeat(this.seats, anchorAt.col, anchorAt.row, lead.seatId ?? lead.preferredSeatId)` so the lead's own (possibly released) chair is never the target. Same `exclude` argument in `addAgent`'s `closestFreeSeat(this.seats, anchorAt.col, anchorAt.row, anchor.seatId ?? anchor.preferredSeatId)` call.
- `rebuildFromLayout`: replace the two passes ("First pass" / "Second pass") with:

```ts
// Every claim is transient; rebuild them from preferences. Preferences
// that no longer name a WORK seat are dropped.
const now = Date.now();
for (const ch of this.characters.values()) {
  ch.restSeatId = null;
  ch.seatId = null;
  ch.seatWait = false;
  ch.seatWaitTarget = null;
  const pref = ch.preferredSeatId ? this.seats.get(ch.preferredSeatId) : undefined;
  if (!pref || pref.role !== 'work') ch.preferredSeatId = null;
}
for (const ch of this.characters.values()) {
  if (ch.isSubagent || !shouldBeSeated(ch, now)) continue;
  const areaLabels = ch.folderName ? this.areaMappings[ch.folderName] : undefined;
  const uid = claimWorkSeat(ch, this.seats, (u) => this.seatZone(u), areaLabels);
  if (!uid) continue;
  const seat = this.seats.get(uid)!;
  seat.assigned = true;
  ch.seatId = uid;
  // Snap to the seat, as the old first pass did.
  ch.tileCol = seat.seatCol;
  ch.tileRow = seat.seatRow;
  ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
  ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
  ch.dir = seat.facingDir;
}
```

The existing "Relocate any characters that ended up outside bounds or on non-walkable tiles" block stays (its `if (ch.seatId) continue;` still means "claimed characters sit on their seat").

- `removeAgent`: also `ch.seatWait = false; ch.seatWaitTarget = null;` (belt).
- `getPersistableSeats`: `seatId: ch.preferredSeatId ?? ch.seatId`.

- [ ] **Step 4: Run the whole webview suite and types**

Run: `cd webview-ui && npx vitest run && npx tsc -b`
Expected: PASS, tsc clean. Any remaining failure in `greeter.test.ts`, `teammateSeating.test.ts`, or `existingAgents`-related tests is read, and the assertion is reconciled with the spec (preferred vs claimed) — never by weakening the assertion below what the spec says.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/officeState.ts webview-ui/test/work-seat-selection.test.ts webview-ui/test/rest-seat-officestate.test.ts
git commit -m "feat(webview): seat preference survives claims; rebuild/reassign/sendToSeat on the claimed model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Remaining `seatId` consumers and the e2e helper

**Files:**

- Modify: `webview-ui/src/office/engine/renderer.ts` (~line 578 seat highlight)
- Modify: `webview-ui/src/office/components/officeCanvasCursor.ts` (`OfficeCursorCharacter` gets `preferredSeatId`; hover rule)
- Modify: `webview-ui/src/office/components/OfficeCanvas.tsx` (~line 786 own-seat click)
- Modify: `webview-ui/src/testHooks.ts` (`getAgentSeats`)
- Modify: `e2e/helpers/office.ts` (`expectTeammateSeatedNextToLead`)
- Test: `webview-ui/test/officeCanvasCursor.test.ts` (extend)

- [ ] **Step 1: Failing test**

In `officeCanvasCursor.test.ts`, add a case next to the existing seat-hover cases: a selected character with `seatId: null, preferredSeatId: 'w1'` hovering seat `w1` (assigned false) → `'pointer'`; hovering another assigned seat → `'default'`. Build the character fixture the way the file's existing helpers do, adding `preferredSeatId`.

- [ ] **Step 2: Run to verify failure**

Run: `cd webview-ui && npx vitest run test/officeCanvasCursor.test.ts`
Expected: FAIL — type error on `preferredSeatId` / rule not implemented.

- [ ] **Step 3: Implement**

- `officeCanvasCursor.ts`: `OfficeCursorCharacter` gains `preferredSeatId?: string | null;` (optional, so the file's existing `{ seatId: null }` fixtures keep compiling); the rule becomes `const own = selectedCh.seatId ?? selectedCh.preferredSeatId; if (!seat.assigned || own === seatId) return 'pointer';`.
- `renderer.ts`: `const ownSeat = selectedChar.seatId ?? selectedChar.preferredSeatId; if (ownSeat === uid) { … SEAT_OWN_COLOR … }`.
- `OfficeCanvas.tsx`: `const own = selectedCh.seatId ?? selectedCh.preferredSeatId; if (own === seatId) { officeState.sendToSeat(...) … }`.
- `testHooks.ts` `getAgentSeats`: `const seatId = ch.seatId ?? ch.preferredSeatId; return { id: ch.id, seatId, areaLabel: seatId ? os.seatZone(seatId) : null, folderName: ch.folderName };`.
- `e2e/helpers/office.ts`: in `closerFreeSeat`, exclude both agents' own seats: `seats.find((s) => !s.assigned && s.uid !== leadSeatId && s.uid !== teammateSeatId && dist(s) < teammateDist)`.

- [ ] **Step 4: Full webview suite, types, lint, build**

Run: `cd webview-ui && npx vitest run && npx tsc -b && npx eslint . && npm run build`
Expected: all clean (the pre-existing `App.tsx` exhaustive-deps warning is not an error).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/renderer.ts webview-ui/src/office/components/officeCanvasCursor.ts webview-ui/src/office/components/OfficeCanvas.tsx webview-ui/src/testHooks.ts e2e/helpers/office.ts webview-ui/test/officeCanvasCursor.test.ts
git commit -m "feat(webview): seat highlight, seat click, test hooks and e2e helper use preferred-vs-claimed seats

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Verification and docs

- [ ] **Step 1: Everything CI runs, minus e2e**

Run: `npm run lint && npm run asyncapi:validate && npm run asyncapi:generate && git diff --exit-code core/src/messages.ts && npm run check-types && npm test`
Expected: clean.

- [ ] **Step 2: E2E — the seat-sensitive specs plus the standalone slice**

Run: `node esbuild.js && npm run e2e -- --workers=1 --grep "standalone|teams|areas|lifecycle"`
Expected: PASS. A failure in `teams.spec.ts` "seated next to lead" or `areas-multiroot.spec.ts` means a helper still reads transient `assigned` state or the hook no longer reports the preferred seat — fix the helper/hook, never the FSM.

- [ ] **Step 3: CLAUDE.md**

In "Office UI" → the **Seats** paragraph, replace "Click character → select (white outline) → click available seat → reassign." with: "Work seats are CLAIMED, not owned: `Character.seatId` is the current claim (taken by `OfficeState.seatClaimStep` before each tick via `claimWorkSeat` — preferred seat → nearest free work seat in-area → unzoned → any → nearest free rest seat — and released by the FSM the moment an idle character walks away), `preferredSeatId` is the user/spawn choice and is what `saveAgentSeats` persists. With nothing free an agent waits standing at the free tile nearest the nearest desk (`seatWaitTarget`) and never types on the floor; sub-agents are untouched. Click character → select (white outline) → click available work seat → sets the preference and claims it."

Commit with `docs:`.
