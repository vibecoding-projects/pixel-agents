/**
 * Pure seat-placement helpers, extracted from OfficeState so they can be unit
 * tested without pulling the canvas/DOM-touching engine into the Node test
 * project (mirrors officeCanvasCursor.ts). Structural types keep this module
 * dependency-free — OfficeState's real Seat/Character satisfy them.
 */

export interface SeatLike {
  seatCol: number;
  seatRow: number;
  assigned: boolean;
  role: 'work' | 'rest';
}

export interface AnchorLike {
  seatId: string | null;
  preferredSeatId?: string | null;
  tileCol: number;
  tileRow: number;
}

/**
 * The tile a teammate should cluster around: its lead's SEAT when the lead has
 * one, otherwise the lead's live tile. A lead is assigned its seat at creation
 * but may still be walking toward it when the teammate is placed; anchoring to
 * the stable seat (not the transient walking tile) keeps clustering deterministic
 * so a closer free seat can't open up once the lead lands. Returns undefined when
 * there is no anchor at all.
 */
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
 * Free seat closest (Manhattan) to a tile — seats teammates beside their
 * lead. Prefers work seats; only considers rest seats when no work seat is
 * free, so a teammate is never clustered onto a couch just because it's
 * nearer than the closest free desk. `exclude` is a uid never returned: the
 * lead's own (possibly released) chair must not be handed to a teammate.
 */
export function closestFreeSeat(
  seats: ReadonlyMap<string, SeatLike>,
  col: number,
  row: number,
  exclude?: string | null,
): string | null {
  const notExcluded = (uid: string) => uid !== exclude;
  return (
    nearestFreeWhere(seats, col, row, (uid, s) => s.role === 'work' && notExcluded(uid)) ??
    nearestFreeWhere(seats, col, row, (uid) => notExcluded(uid))
  );
}

export interface ClaimLike {
  tileCol: number;
  tileRow: number;
  preferredSeatId: string | null;
}

/**
 * The seat a character claims when it needs one: its preferred seat when that
 * is a free work seat; else the nearest free work seat inside one of its
 * folder's areas, then the nearest unzoned one, then any; else the nearest
 * free rest seat (the office is oversubscribed — working on the sofa beats
 * standing); else null. Mirrors findFreeSeat's area stages with proximity in
 * place of random choice. `exclude` drops candidates the caller found
 * unreachable so the retry never hands back the same seat.
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
