import { PTY_MAX_CHUNK_BYTES } from '../constants.js';
import type { PtyWorkerOptions } from './ptyWorker.js';
import { PtyWorker } from './ptyWorker.js';

export interface PtyStartOptions {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  /** Per-agent scrollback cap (lines/chunks kept for replay). */
  scrollbackCapacity: number;
}

export interface PtyManagerOptions {
  /** Outbound funnel — typically `(m) => store.broadcast(m)`. Delivery-side
   *  privilege filtering happens in the WS wiring, not here. */
  broadcast(msg: Record<string, unknown>): void;
  /** Test seam: replaces the real node-pty-backed worker. */
  workerFactory?: (opts: PtyWorkerOptions) => PtyWorker;
}

/**
 * Owns one PtyWorker per agent id. Ported from v2-orchestrator's PtyManager,
 * adapted to upstream's dispatch style: the client-message handler calls the
 * imperative methods directly (write/resize/scrollback) instead of the manager
 * subscribing to a message source. Frames use `id` (upstream convention).
 *
 * Reaping model (matches the v2 reference): a worker entry is RETAINED after
 * its process exits, so a late-mounting pane can still replay scrollback via
 * terminalPaneReady and learn the exit through exitInfo(). Workers are reaped
 * explicitly — stop()/disposeAll() delete synchronously — and start() replaces
 * a dead retained entry. Exit frames are broadcast only for the CURRENT
 * worker of an id: a worker reaped by stop() or already replaced by a restart
 * is stale, and its late exit must not paint an exit marker over a live pane
 * or trigger crash handling.
 *
 * Wire protocol produced (all privileged-delivery, see httpServer):
 *   ptyData { id, data }        — live output chunks
 *   ptyExit { id, code, signal? } — the current worker's exit
 *   agentCrashed { id, code, signal? } — non-zero/signalled current-worker exits
 *
 * crashedAgentIds() exposes the same abnormal-exit predicate for reload-time
 * state: existingAgents.crashedAgentIds (privileged replies only) lets a
 * reconnecting client re-show the crash glyph for ids it missed the
 * agentCrashed broadcast for.
 */
export class PtyManager {
  private readonly workers = new Map<number, PtyWorker>();
  /** Last exit of the RETAINED (dead) worker per id. Cleared when a new
   *  worker starts or the entry is reaped. Lets terminalPaneReady tell a
   *  late-mounting pane that this terminal already ended. */
  private readonly lastExit = new Map<number, { code: number; signal?: string }>();
  private readonly factory: (opts: PtyWorkerOptions) => PtyWorker;

  constructor(private readonly opts: PtyManagerOptions) {
    this.factory = opts.workerFactory ?? ((o) => new PtyWorker(o));
  }

  /** Idempotent while the agent's worker is ALIVE; a dead retained entry is
   *  replaced by a fresh worker (the restart path). */
  start(id: number, startOpts: PtyStartOptions): void {
    if (this.workers.get(id)?.isAlive()) return;
    this.lastExit.delete(id);

    const worker = this.factory({
      shell: startOpts.shell,
      args: startOpts.args,
      cwd: startOpts.cwd,
      env: startOpts.env,
      cols: startOpts.cols,
      rows: startOpts.rows,
      scrollbackCapacity: startOpts.scrollbackCapacity,
    });

    worker.onData((chunk) => {
      if (this.workers.get(id) === worker) this.emitData(id, chunk);
    });
    worker.onExit(({ code, signal }) => {
      // Stale worker (reaped by stop(), or replaced by a restart): silent.
      if (this.workers.get(id) !== worker) return;
      // Retain the entry so a late-mounting pane can still replay scrollback.
      this.lastExit.set(id, { code, signal });
      this.opts.broadcast({ type: 'ptyExit', id, code, signal });
      if (code !== 0 || signal !== undefined) {
        this.opts.broadcast({ type: 'agentCrashed', id, code, signal });
      }
    });

    this.workers.set(id, worker);
  }

  write(id: number, data: string): void {
    this.workers.get(id)?.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    this.workers.get(id)?.resize(cols, rows);
  }

  scrollback(id: number): string[] {
    return this.workers.get(id)?.scrollback() ?? [];
  }

  /** Live worker OR a retained dead entry (a worker that exited, or a
   *  restored agent marked stopped) — anything terminalPaneReady can replay. */
  has(id: number): boolean {
    return this.workers.has(id) || this.lastExit.has(id);
  }

  /** Register a dead entry for an agent with no worker at all: a pty-backed
   *  agent restored after a daemon restart. Its pane then replays a synthetic
   *  exit and offers Restart, exactly like a worker that died. Never touches a
   *  live worker; nothing is broadcast (the client learns it via
   *  existingAgents.crashedAgentIds). */
  markStopped(id: number, exit: { code: number; signal?: string }): void {
    if (this.workers.get(id)?.isAlive()) return;
    this.lastExit.set(id, exit);
  }

  /** The retained worker's exit, if it has ended. Undefined while alive. */
  exitInfo(id: number): { code: number; signal?: string } | undefined {
    return this.lastExit.get(id);
  }

  /** Ids retained in `lastExit` whose exit was abnormal (non-zero code or a
   *  signal) — the same predicate `start()`'s exit handler uses to decide
   *  `agentCrashed` emission. There is no separate "intentional stop" marker:
   *  stop() deletes the `lastExit` entry synchronously, so intentional stops
   *  are excluded structurally rather than by a second predicate. */
  crashedAgentIds(): number[] {
    const ids: number[] = [];
    for (const [id, exit] of this.lastExit) {
      if (exit.code !== 0 || exit.signal !== undefined) ids.push(id);
    }
    return ids;
  }

  /** Explicit reap (close/restart): kill and delete synchronously, so the
   *  old worker's late exit is recognizably stale and stays silent. */
  stop(id: number): void {
    // A stopped-only entry (restored agent, no worker) is reaped the same way.
    this.lastExit.delete(id);
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.kill();
    this.workers.delete(id);
  }

  disposeAll(): void {
    for (const worker of this.workers.values()) {
      try {
        worker.kill();
      } catch {
        // best effort
      }
    }
    this.workers.clear();
    this.lastExit.clear();
  }

  private emitData(id: number, chunk: string): void {
    if (Buffer.byteLength(chunk, 'utf8') <= PTY_MAX_CHUNK_BYTES) {
      this.opts.broadcast({ type: 'ptyData', id, data: chunk });
      return;
    }
    // Pathological single write — halve (in order) until every piece fits the
    // BYTE cap. The split point steps over a surrogate pair so an astral char
    // on the boundary is never torn into two replacement characters.
    const pieces: string[] = [chunk];
    while (pieces.length > 0) {
      const piece = pieces.shift()!;
      if (Buffer.byteLength(piece, 'utf8') <= PTY_MAX_CHUNK_BYTES) {
        this.opts.broadcast({ type: 'ptyData', id, data: piece });
        continue;
      }
      let half = Math.ceil(piece.length / 2);
      const boundary = piece.charCodeAt(half - 1);
      if (boundary >= 0xd800 && boundary <= 0xdbff) half += 1; // high surrogate
      pieces.unshift(piece.slice(0, half), piece.slice(half));
    }
  }
}
