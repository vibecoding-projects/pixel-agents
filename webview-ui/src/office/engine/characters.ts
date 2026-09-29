import {
  AWAITING_REST_DELAY_MS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  STEP_OFF_PAUSE_MAX_SEC,
  STEP_OFF_PAUSE_MIN_SEC,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import { findPath } from '../layout/tileMap.js';
import type { CharacterSprites } from '../sprites/spriteData.js';
import { isReadingToolName } from '../toolUtils.js';
import type { Character, Seat, SpriteData, TileType as TileTypeVal } from '../types.js';
import { CharacterState, Direction, TILE_SIZE } from '../types.js';

/** Whether a tool should show the reading animation (vs typing). Taxonomy comes
 *  from the active HookProvider via the `providerCapabilities` message. */
export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false;
  return isReadingToolName(tool);
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0,
): Character {
  const col = seat ? seat.seatCol : 1;
  const row = seat ? seat.seatRow : 1;
  const center = tileCenter(col, row);
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    // New agents spawn idle. isActive flips true on UserPromptSubmit (first real
    // interaction). This keeps the overlay from reading "Working…" on a session
    // the user hasn't touched yet.
    isActive: false,
    seatId,
    preferredSeatId: seatId,
    seatWait: false,
    seatWaitTarget: null,
    restSeatId: null,
    bubbleType: null,
    bubbleTimer: 0,
    awaitingSince: null,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    ptyActivityUntil: 0,
    crashed: false,
    crashedAcknowledged: false,
  };
}

/** @internal — exported for tests. At the work seat when actively working OR
 *  while the awaiting-user latch is fresh. The latch EXPIRES after
 *  AWAITING_REST_DELAY_MS ("short desk wait, then rest"): an ignored agent
 *  releases the desk and follows the normal wander→couch flow; any new
 *  activity (isActive) walks it back. */
export function shouldBeSeated(ch: Character, now: number = Date.now()): boolean {
  return (
    ch.isActive || (ch.awaitingSince != null && now - ch.awaitingSince < AWAITING_REST_DELAY_MS)
  );
}

/** @internal */
export function isChairTile(col: number, row: number, seats: Map<string, Seat>): boolean {
  for (const seat of seats.values()) {
    if (seat.seatCol === col && seat.seatRow === row) return true;
  }
  return false;
}

/** Free the character's claimed seat (work or fallback rest), keeping its
 *  preference. No-op when nothing is claimed. */
export function releaseWorkSeat(ch: Character, seats: Map<string, Seat>): void {
  if (!ch.seatId) return;
  const seat = seats.get(ch.seatId);
  if (seat) seat.assigned = false;
  ch.seatId = null;
}

/** Nearest free rest seat by Manhattan distance, or null. */
export function findNearestFreeRestSeat(ch: Character, seats: Map<string, Seat>): string | null {
  let bestUid: string | null = null;
  let bestDist = Infinity;
  for (const [uid, seat] of seats) {
    if (seat.assigned || seat.role !== 'rest') continue;
    const dist = Math.abs(seat.seatCol - ch.tileCol) + Math.abs(seat.seatRow - ch.tileRow);
    if (dist < bestDist) {
      bestDist = dist;
      bestUid = uid;
    }
  }
  return bestUid;
}

export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  now: number = Date.now(),
): void {
  ch.frameTimer += dt;

  switch (ch.state) {
    case CharacterState.TYPE: {
      if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
        ch.frameTimer -= TYPE_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 2;
      }
      // Work started while resting on a couch — release it and head to the desk.
      if (shouldBeSeated(ch, now) && ch.restSeatId) {
        const rest = seats.get(ch.restSeatId);
        if (rest) rest.assigned = false;
        ch.restSeatId = null;
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
        break;
      }
      if (!shouldBeSeated(ch, now)) {
        if (ch.seatTimer > 0) {
          ch.seatTimer -= dt;
          break;
        }
        ch.seatTimer = 0; // clear sentinel
        if (ch.restSeatId) break; // resting on the couch — stay put
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
        // Short step-off pause: standing on the chair tile reads as working.
        ch.wanderTimer = randomRange(STEP_OFF_PAUSE_MIN_SEC, STEP_OFF_PAUSE_MAX_SEC);
        ch.wanderCount = 0;
        ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX);
      }
      break;
    }

    case CharacterState.IDLE: {
      ch.frame = 0;
      if (ch.seatTimer < 0) ch.seatTimer = 0; // clear turn-end sentinel
      if (shouldBeSeated(ch, now)) {
        if (ch.restSeatId) {
          const rest = seats.get(ch.restSeatId);
          if (rest) rest.assigned = false;
          ch.restSeatId = null;
        }
        if (!ch.seatId) {
          ch.state = CharacterState.TYPE;
          ch.frame = 0;
          ch.frameTimer = 0;
          break;
        }
        const seat = seats.get(ch.seatId);
        if (seat) {
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            seat.seatCol,
            seat.seatRow,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
          } else {
            ch.state = CharacterState.TYPE;
            ch.dir = seat.facingDir;
            ch.frame = 0;
            ch.frameTimer = 0;
          }
        }
        break;
      }
      ch.wanderTimer -= dt;
      if (ch.wanderTimer <= 0) {
        // Wandered enough — rest on a couch (sub-agents never claim couches).
        if (ch.wanderCount >= ch.wanderLimit && !ch.restSeatId && !ch.isSubagent) {
          const restUid = findNearestFreeRestSeat(ch, seats);
          if (restUid) {
            const rest = seats.get(restUid);
            if (rest) {
              // Claim BEFORE pathfinding; roll back if unreachable.
              rest.assigned = true;
              ch.restSeatId = restUid;
              const key = `${rest.seatCol},${rest.seatRow}`;
              const wasBlocked = blockedTiles.has(key);
              if (wasBlocked) blockedTiles.delete(key);
              const path = findPath(
                ch.tileCol,
                ch.tileRow,
                rest.seatCol,
                rest.seatRow,
                tileMap,
                blockedTiles,
              );
              if (wasBlocked) blockedTiles.add(key);
              if (path.length > 0) {
                ch.path = path;
                ch.moveProgress = 0;
                ch.state = CharacterState.WALK;
                ch.frame = 0;
                ch.frameTimer = 0;
                break;
              }
              rest.assigned = false;
              ch.restSeatId = null;
            }
          }
        }
        if (walkableTiles.length > 0) {
          const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
          const path = findPath(
            ch.tileCol,
            ch.tileRow,
            target.col,
            target.row,
            tileMap,
            blockedTiles,
          );
          if (path.length > 0) {
            ch.path = path;
            ch.moveProgress = 0;
            ch.state = CharacterState.WALK;
            ch.frame = 0;
            ch.frameTimer = 0;
            ch.wanderCount++;
          }
        }
        ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
      }
      break;
    }

    case CharacterState.WALK: {
      // Walk animation
      if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
        ch.frameTimer -= WALK_FRAME_DURATION_SEC;
        ch.frame = (ch.frame + 1) % 4;
      }

      if (ch.path.length === 0) {
        const center = tileCenter(ch.tileCol, ch.tileRow);
        ch.x = center.x;
        ch.y = center.y;

        if (shouldBeSeated(ch, now)) {
          if (!ch.seatId) {
            ch.state = CharacterState.TYPE;
          } else {
            const seat = seats.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CharacterState.TYPE;
              ch.dir = seat.facingDir;
            } else {
              ch.state = CharacterState.IDLE;
            }
          }
        } else if (ch.restSeatId) {
          const rest = seats.get(ch.restSeatId);
          if (rest && ch.tileCol === rest.seatCol && ch.tileRow === rest.seatRow) {
            ch.state = CharacterState.TYPE;
            ch.dir = rest.facingDir;
            ch.wanderCount = 0;
            ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX);
          } else {
            // Lost the rest seat during travel — release and resume wandering.
            if (rest) rest.assigned = false;
            ch.restSeatId = null;
            ch.state = CharacterState.IDLE;
            ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
          }
        } else {
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = isChairTile(ch.tileCol, ch.tileRow, seats)
            ? randomRange(STEP_OFF_PAUSE_MIN_SEC, STEP_OFF_PAUSE_MAX_SEC)
            : randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC);
        }
        ch.frame = 0;
        ch.frameTimer = 0;
        break;
      }

      // Move toward next tile in path
      const nextTile = ch.path[0];
      ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row);

      ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt;

      const fromCenter = tileCenter(ch.tileCol, ch.tileRow);
      const toCenter = tileCenter(nextTile.col, nextTile.row);
      const t = Math.min(ch.moveProgress, 1);
      ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
      ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

      if (ch.moveProgress >= 1) {
        // Arrived at next tile
        ch.tileCol = nextTile.col;
        ch.tileRow = nextTile.row;
        ch.x = toCenter.x;
        ch.y = toCenter.y;
        ch.path.shift();
        ch.moveProgress = 0;
      }

      // If should be seated (active or awaiting user) while wandering, repath to seat
      if (shouldBeSeated(ch, now) && ch.seatId) {
        const seat = seats.get(ch.seatId);
        if (seat) {
          const lastStep = ch.path[ch.path.length - 1];
          if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
            // Release any rest claim — diverting to the desk.
            if (ch.restSeatId) {
              const rest = seats.get(ch.restSeatId);
              if (rest) rest.assigned = false;
              ch.restSeatId = null;
            }
            const newPath = findPath(
              ch.tileCol,
              ch.tileRow,
              seat.seatCol,
              seat.seatRow,
              tileMap,
              blockedTiles,
            );
            if (newPath.length > 0) {
              ch.path = newPath;
              ch.moveProgress = 0;
            }
          }
        }
      }
      break;
    }
  }
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  switch (ch.state) {
    case CharacterState.TYPE:
      // Seated but not active: static pose (couch rest, or between turns).
      if (!ch.isActive) {
        return sprites.walk[ch.dir][1];
      }
      if (ch.currentTool) {
        if (isReadingTool(ch.currentTool)) {
          return sprites.reading[ch.dir][ch.frame % 2];
        }
        return sprites.typing[ch.dir][ch.frame % 2];
      }
      // No tool: pty bytes flowing → typing; silence between bursts → reading.
      if (Date.now() < ch.ptyActivityUntil) {
        return sprites.typing[ch.dir][ch.frame % 2];
      }
      return sprites.reading[ch.dir][ch.frame % 2];
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4];
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1];
    default:
      return sprites.walk[ch.dir][1];
  }
}

/** Display label priority: customTitle (user-given name) → agentName (team
 *  role) → terminalName → "Agent #id". Empty strings count as absent — the
 *  renameAgent clear path broadcasts '' and must fall through. */
export function characterLabel(ch: {
  customTitle?: string;
  agentName?: string;
  terminalName?: string;
  id: number;
}): string {
  return ch.customTitle || ch.agentName || ch.terminalName || `Agent #${ch.id}`;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
