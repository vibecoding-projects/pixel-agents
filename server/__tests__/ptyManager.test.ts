import { describe, expect, it } from 'vitest';

import { PTY_MAX_CHUNK_BYTES } from '../src/constants.js';
import { PtyManager } from '../src/pty/ptyManager.js';
import type { PtyWorker } from '../src/pty/ptyWorker.js';

interface Frame {
  type: string;
  id?: number;
  data?: string;
  code?: number;
  signal?: string;
}

function makeBroadcast() {
  const frames: Frame[] = [];
  return {
    frames,
    broadcast: (m: Record<string, unknown>) => void frames.push(m as unknown as Frame),
  };
}

interface FakeWorker {
  worker: PtyWorker;
  writes: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
  exited: boolean;
  fireData: (chunk: string) => void;
  fireExit: (info: { code: number; signal?: string }) => void;
}

function makeFakeWorker(scrollbackLines: string[] = []): FakeWorker {
  const dataHandlers: ((c: string) => void)[] = [];
  const exitHandlers: ((info: { code: number; signal?: string }) => void)[] = [];
  const state: FakeWorker = {
    writes: [],
    resizes: [],
    killed: false,
    exited: false,
    worker: undefined as unknown as PtyWorker,
    fireData: (chunk) => dataHandlers.forEach((h) => h(chunk)),
    fireExit: (info) => {
      state.exited = true;
      exitHandlers.forEach((h) => h(info));
    },
  };
  state.worker = {
    onData: (h: (c: string) => void) => void dataHandlers.push(h),
    onExit: (h: (info: { code: number; signal?: string }) => void) => void exitHandlers.push(h),
    write: (d: string) => void state.writes.push(d),
    resize: (c: number, r: number) => void state.resizes.push([c, r]),
    kill: () => {
      state.killed = true;
    },
    scrollback: () => scrollbackLines,
    isAlive: () => !state.killed && !state.exited,
  } as unknown as PtyWorker;
  return state;
}

const START = {
  shell: '/bin/sh',
  args: [] as string[],
  cwd: '/tmp',
  env: {},
  cols: 80,
  rows: 24,
  scrollbackCapacity: 100,
};

describe('PtyManager', () => {
  it('forwards worker output as ptyData frames with the agent id', () => {
    const { frames, broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(7, START);
    fake.fireData('hello');
    expect(frames).toContainEqual({ type: 'ptyData', id: 7, data: 'hello' });
  });

  it('splits oversized chunks: every frame fits the cap, order and content preserved', () => {
    const { frames, broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(1, START);
    const big = 'x'.repeat(PTY_MAX_CHUNK_BYTES * 3 + 5);
    fake.fireData(big);
    const data = frames.filter((f) => f.type === 'ptyData');
    expect(data.length).toBeGreaterThan(1);
    for (const frame of data) {
      expect(Buffer.byteLength(frame.data ?? '', 'utf8')).toBeLessThanOrEqual(PTY_MAX_CHUNK_BYTES);
    }
    expect(data.map((f) => f.data).join('')).toBe(big);
  });

  it('routes write/resize to the worker and scrollback back to the caller', () => {
    const { broadcast } = makeBroadcast();
    const fake = makeFakeWorker(['line-1', 'line-2']);
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(2, START);
    mgr.write(2, 'ls\n');
    mgr.resize(2, 100, 30);
    expect(fake.writes).toEqual(['ls\n']);
    expect(fake.resizes).toEqual([[100, 30]]);
    expect(mgr.scrollback(2)).toEqual(['line-1', 'line-2']);
    expect(mgr.scrollback(999)).toEqual([]);
  });

  it('start is idempotent per id', () => {
    const { broadcast } = makeBroadcast();
    let constructed = 0;
    const fake = makeFakeWorker();
    const mgr = new PtyManager({
      broadcast,
      workerFactory: () => {
        constructed += 1;
        return fake.worker;
      },
    });
    mgr.start(3, START);
    mgr.start(3, START);
    expect(constructed).toBe(1);
  });

  it('non-zero exit broadcasts ptyExit AND agentCrashed', () => {
    const { frames, broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(4, START);
    fake.fireExit({ code: 1 });
    expect(frames).toContainEqual({ type: 'ptyExit', id: 4, code: 1, signal: undefined });
    expect(frames).toContainEqual({ type: 'agentCrashed', id: 4, code: 1, signal: undefined });
  });

  it('clean exit broadcasts ptyExit only', () => {
    const { frames, broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(5, START);
    fake.fireExit({ code: 0 });
    expect(frames.some((f) => f.type === 'ptyExit')).toBe(true);
    expect(frames.some((f) => f.type === 'agentCrashed')).toBe(false);
  });

  it('a dead worker is RETAINED: scrollback + exitInfo survive for late panes', () => {
    const { broadcast } = makeBroadcast();
    const fake = makeFakeWorker(['old-line-1', 'old-line-2']);
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(4, START);
    fake.fireExit({ code: 137, signal: 'SIGKILL' });
    expect(mgr.has(4)).toBe(true);
    expect(mgr.scrollback(4)).toEqual(['old-line-1', 'old-line-2']);
    expect(mgr.exitInfo(4)).toEqual({ code: 137, signal: 'SIGKILL' });
  });

  it('stop() reaps synchronously and suppresses all frames from the old worker', () => {
    const { frames, broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(6, START);
    mgr.stop(6);
    expect(fake.killed).toBe(true);
    expect(mgr.has(6)).toBe(false);
    // Exit lands after the reap: neither ptyExit nor agentCrashed — the pane
    // was already told about the removal/restart through other channels.
    fake.fireExit({ code: 0, signal: 'SIGTERM' });
    expect(frames.some((f) => f.type === 'ptyExit')).toBe(false);
    expect(frames.some((f) => f.type === 'agentCrashed')).toBe(false);
  });

  it('restart (stop then start) never mis-broadcasts the OLD worker exit, even late', () => {
    const { frames, broadcast } = makeBroadcast();
    const first = makeFakeWorker();
    const second = makeFakeWorker();
    const workers = [first, second];
    const mgr = new PtyManager({ broadcast, workerFactory: () => workers.shift()!.worker });
    mgr.start(8, START);
    mgr.stop(8);
    mgr.start(8, START); // new worker installed BEFORE the old exit lands
    first.fireExit({ code: 0, signal: 'SIGTERM' }); // stale — must be silent
    expect(frames.some((f) => f.type === 'ptyExit')).toBe(false);
    expect(frames.some((f) => f.type === 'agentCrashed')).toBe(false);
    // The new worker's crash still reports normally.
    second.fireExit({ code: 137, signal: 'SIGKILL' });
    expect(frames.filter((f) => f.type === 'agentCrashed')).toHaveLength(1);
  });

  it('start replaces a dead retained worker and clears its exitInfo', () => {
    const { broadcast } = makeBroadcast();
    const first = makeFakeWorker();
    const second = makeFakeWorker();
    const workers = [first, second];
    let constructed = 0;
    const mgr = new PtyManager({
      broadcast,
      workerFactory: () => {
        constructed += 1;
        return workers.shift()!.worker;
      },
    });
    mgr.start(9, START);
    first.fireExit({ code: 1 });
    expect(mgr.exitInfo(9)).toBeDefined();
    mgr.start(9, START); // dead entry -> replaced, not idempotent-skipped
    expect(constructed).toBe(2);
    expect(mgr.exitInfo(9)).toBeUndefined();
  });

  it('splits oversized multibyte chunks by BYTE length', () => {
    const { frames, broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(12, START);
    // 3-byte chars: byte length is 3x the code-unit length, so a code-unit
    // split would emit frames ~3x over the cap.
    const bigMultibyte = '€'.repeat(Math.floor(PTY_MAX_CHUNK_BYTES / 3) + 10);
    fake.fireData(bigMultibyte);
    const data = frames.filter((f) => f.type === 'ptyData');
    expect(data.length).toBeGreaterThan(1);
    for (const frame of data) {
      expect(Buffer.byteLength(frame.data ?? '', 'utf8')).toBeLessThanOrEqual(PTY_MAX_CHUNK_BYTES);
    }
    expect(data.map((f) => f.data).join('')).toBe(bigMultibyte);
  });

  it('crashedAgentIds() reports ids with abnormal retained exits, excluding clean ones', () => {
    const { broadcast } = makeBroadcast();
    const crashed = makeFakeWorker();
    const clean = makeFakeWorker();
    const workers = [crashed, clean];
    const mgr = new PtyManager({ broadcast, workerFactory: () => workers.shift()!.worker });
    mgr.start(20, START);
    mgr.start(21, START);
    crashed.fireExit({ code: 1 });
    clean.fireExit({ code: 0 });
    expect(mgr.crashedAgentIds()).toEqual([20]);
  });

  it('crashedAgentIds excludes intentional stops', () => {
    const { broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(22, START);
    mgr.stop(22);
    expect(mgr.crashedAgentIds()).toEqual([]);
  });

  it('disposeAll kills every worker without crashes', () => {
    const { frames, broadcast } = makeBroadcast();
    const a = makeFakeWorker();
    const b = makeFakeWorker();
    const workers = [a, b];
    const mgr = new PtyManager({ broadcast, workerFactory: () => workers.shift()!.worker });
    mgr.start(10, START);
    mgr.start(11, START);
    mgr.disposeAll();
    expect(a.killed && b.killed).toBe(true);
    a.fireExit({ code: 0, signal: 'SIGTERM' });
    b.fireExit({ code: 0, signal: 'SIGTERM' });
    expect(frames.some((f) => f.type === 'agentCrashed')).toBe(false);
    expect(mgr.has(10)).toBe(false);
  });
});

describe('PtyManager.markStopped (restored agents with no live worker)', () => {
  it('registers a dead retained entry: has() is true, exitInfo set, no scrollback, counted as crashed', () => {
    const { frames, broadcast } = makeBroadcast();
    const mgr = new PtyManager({ broadcast, workerFactory: () => makeFakeWorker().worker });
    mgr.markStopped(7, { code: 0, signal: 'SIGHUP' });
    expect(mgr.has(7)).toBe(true);
    expect(mgr.exitInfo(7)).toEqual({ code: 0, signal: 'SIGHUP' });
    expect(mgr.scrollback(7)).toEqual([]);
    expect(mgr.crashedAgentIds()).toEqual([7]);
    expect(frames).toHaveLength(0); // nothing is broadcast: the client learns it via existingAgents
  });

  it('start() replaces a stopped entry and stop() reaps it', () => {
    const { broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.markStopped(7, { code: 0, signal: 'SIGHUP' });
    mgr.start(7, START);
    expect(mgr.exitInfo(7)).toBeUndefined();
    expect(mgr.crashedAgentIds()).toEqual([]);
    mgr.write(7, 'x');
    expect(fake.writes).toEqual(['x']);
    mgr.stop(7);
    expect(mgr.has(7)).toBe(false);
    mgr.markStopped(8, { code: 0, signal: 'SIGHUP' });
    mgr.stop(8);
    expect(mgr.has(8)).toBe(false);
  });

  it('markStopped never overrides a live worker', () => {
    const { broadcast } = makeBroadcast();
    const fake = makeFakeWorker();
    const mgr = new PtyManager({ broadcast, workerFactory: () => fake.worker });
    mgr.start(7, START);
    mgr.markStopped(7, { code: 0, signal: 'SIGHUP' });
    expect(mgr.exitInfo(7)).toBeUndefined();
    expect(mgr.crashedAgentIds()).toEqual([]);
  });
});
