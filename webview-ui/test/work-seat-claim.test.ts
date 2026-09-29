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
