import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider, LiveProcess } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { MOVE_HANDOFF_GRACE_MS } from '../src/constants.js';
import { moveRefusalReason, type MoveSessionDeps, moveSessionHere } from '../src/moveSession.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager, PtyStartOptions } from '../src/pty/ptyManager.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 4,
    sessionId: 'sess-4',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/sess-4.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function makeFakePtyHost() {
  const starts: Array<{ id: number; opts: PtyStartOptions }> = [];
  const host = {
    start: vi.fn((id: number, opts: PtyStartOptions) => starts.push({ id, opts })),
    stop: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn(() => true),
    exitInfo: vi.fn(() => undefined),
    crashedAgentIds: vi.fn(() => []),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, starts };
}

describe('moveSessionHere', () => {
  let tmp: string;
  let transcript: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;
  let starts: Array<{ id: number; opts: PtyStartOptions }>;
  let kill: ReturnType<typeof vi.fn>;
  let alive: boolean;

  function provider(live: LiveProcess | null): HookProvider {
    return {
      ...claudeProvider,
      findLiveProcess: vi.fn(async () => live),
      transcriptCwd: () => undefined,
    };
  }

  function deps(live: LiveProcess | null, over: Partial<MoveSessionDeps> = {}): MoveSessionDeps {
    return {
      store,
      runtime,
      provider: provider(live),
      launchCwd: tmp,
      send: (m) => sent.push(m),
      kill: kill as unknown as MoveSessionDeps['kill'],
      isAlive: () => alive,
      sleep: async () => {
        alive = false; // the process "exits" on the first wait
      },
      ...over,
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-move-'));
    transcript = path.join(tmp, 'sess-4.jsonl');
    fs.writeFileSync(transcript, '{"type":"user","cwd":"/nope"}\n');
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const fake = makeFakePtyHost();
    runtime.setPtyHost(fake.host);
    starts = fake.starts;
    sent = [];
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    kill = vi.fn();
    alive = true;
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stops the outside process, resumes in a pty in its cwd, flips the agent, broadcasts sessionMoved', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript }));
    const ok = await moveSessionHere(4, deps({ pid: 777, cwd: tmp }));
    expect(ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(starts).toHaveLength(1);
    expect(starts[0].id).toBe(4);
    expect(starts[0].opts.cwd).toBe(tmp);
    expect(starts[0].opts.args.at(-1)).toContain('claude --resume sess-4');
    const agent = store.get(4)!;
    expect(agent.isExternal).toBe(false);
    expect(agent.ptyBacked).toBe(true);
    expect(agent.spawnCwd).toBe(tmp);
    expect(agent.terminalRef?.name).toMatch(/^Claude Code #\d+$/);
    expect(agent.moveInFlight).toBeFalsy();
    expect(broadcasts.at(-1)).toEqual({
      type: 'sessionMoved',
      id: 4,
      terminalName: agent.terminalRef!.name,
    });
    expect(sent).toHaveLength(0);
  });

  it('sets the handoff latch and pendingClear BEFORE signalling', async () => {
    const agent = createTestAgent({ jsonlFile: transcript });
    store.set(4, agent);
    let latchedAtKill = false;
    kill.mockImplementation(() => {
      latchedAtKill = agent.pendingHandoff === true && agent.pendingClear === true;
    });
    await moveSessionHere(4, deps({ pid: 777, cwd: tmp }));
    expect(latchedAtKill).toBe(true);
  });

  it('with no live process, resumes without signalling, in the transcript cwd, then launchCwd', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript }));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-move-cwd-'));
    const d = deps(null);
    d.provider = { ...d.provider, transcriptCwd: () => other };
    await moveSessionHere(4, d);
    expect(kill).not.toHaveBeenCalled();
    expect(starts[0].opts.cwd).toBe(other);
    fs.rmSync(other, { recursive: true, force: true });

    store.set(5, createTestAgent({ id: 5, sessionId: 'sess-5', jsonlFile: transcript }));
    const d2 = deps(null);
    d2.provider = { ...d2.provider, transcriptCwd: () => '/does/not/exist' };
    await moveSessionHere(5, d2);
    expect(starts[1].opts.cwd).toBe(tmp);
  });

  it('escalates to SIGKILL and fails when the process will not die; agent untouched', async () => {
    const agent = createTestAgent({ jsonlFile: transcript });
    store.set(4, agent);
    // never exits; the wait is bounded by poll count, so this stays fast
    const d = deps({ pid: 777, cwd: tmp }, { sleep: async () => {} });
    const ok = await moveSessionHere(4, d);
    expect(ok).toBe(false);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(777, 'SIGKILL');
    expect(starts).toHaveLength(0);
    expect(agent.isExternal).toBe(true);
    expect(agent.ptyBacked).toBeFalsy();
    expect(agent.pendingHandoff).toBe(false);
    expect(agent.pendingClear).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });

  it('a throwing kill (EPERM) fails cleanly with the latch cleared and nothing spawned', async () => {
    const agent = createTestAgent({ jsonlFile: transcript });
    store.set(4, agent);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(await moveSessionHere(4, deps({ pid: 777, cwd: tmp }))).toBe(false);
    expect(starts).toHaveLength(0);
    expect(agent.pendingHandoff).toBe(false);
    expect(agent.pendingClear).toBe(false);
    expect(agent.moveInFlight).toBeFalsy();
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });

  it('the grace timer clears both latch flags when no hook ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const agent = createTestAgent({ jsonlFile: transcript });
      store.set(4, agent);
      await moveSessionHere(4, deps(null));
      expect(agent.pendingHandoff).toBe(true);
      expect(agent.pendingClear).toBe(true);
      vi.advanceTimersByTime(MOVE_HANDOFF_GRACE_MS + 1);
      expect(agent.pendingHandoff).toBe(false);
      expect(agent.pendingClear).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a second move while one is in flight', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript }));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = deps(
      { pid: 777, cwd: tmp },
      {
        sleep: async () => {
          await gate;
          alive = false;
        },
      },
    );
    const first = moveSessionHere(4, d);
    const second = await moveSessionHere(4, d);
    expect(second).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
    release();
    expect(await first).toBe(true);
    expect(starts).toHaveLength(1);
  });

  it('refuses a lead whose inline teammates are live, before signalling', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript, isTeamLead: true, teamName: 't' }));
    store.set(
      9,
      createTestAgent({
        id: 9,
        sessionId: 'sess-9',
        jsonlFile: transcript,
        leadAgentId: 4,
        agentName: 'r',
      }),
    );
    expect(await moveSessionHere(4, deps({ pid: 777 }))).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });

  it('refuses before signalling when the transcript is missing', async () => {
    store.set(4, createTestAgent({ jsonlFile: path.join(tmp, 'gone.jsonl') }));
    expect(await moveSessionHere(4, deps({ pid: 777 }))).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });
});

describe('moveRefusalReason', () => {
  const base = (over: Partial<AgentState>) => createTestAgent({ jsonlFile: '/x', ...over });
  it('accepts a plain external agent with a transcript', () => {
    expect(moveRefusalReason(base({}), true)).toBeNull();
  });
  it('refuses unknown, non-external, pty-backed, sessionless, transcript-less, in-flight', () => {
    expect(moveRefusalReason(undefined, true)).toBeTruthy();
    expect(moveRefusalReason(base({ isExternal: false }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ ptyBacked: true }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ sessionId: '' }), true)).toBeTruthy();
    expect(moveRefusalReason(base({}), false)).toBeTruthy();
    expect(moveRefusalReason(base({ moveInFlight: true }), true)).toBeTruthy();
  });
  it('refuses a lead that still has inline teammates (SIGTERM would kill them too)', () => {
    expect(moveRefusalReason(base({ isTeamLead: true }), true, true)).toBeTruthy();
    expect(moveRefusalReason(base({ isTeamLead: true }), true, false)).toBeNull();
  });

  it('refuses teammates and sub-agent spawns', () => {
    expect(moveRefusalReason(base({ leadAgentId: 1 }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ agentName: 'researcher' }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ spawnToolUseId: 'toolu_1' }), true)).toBeTruthy();
  });
});
