import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CLOSE_GRACE_MS } from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager } from '../src/pty/ptyManager.js';
import type { AgentState } from '../src/types.js';

function makeAgent(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `sess-${id}`,
    terminalRef: { name: `Claude Code #${id}` } as vscode.Terminal,
    isExternal: false,
    projectDir: '/p',
    jsonlFile: `/p/sess-${id}.jsonl`,
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
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 1,
    ptyBacked: true,
    customTitle: `T${id}`,
    spawnCwd: '/p',
    ...overrides,
  } as AgentState;
}

function fakeHost() {
  const stops: number[] = [];
  const host = {
    start: vi.fn(),
    stop: vi.fn((id: number) => stops.push(id)),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn(() => true),
    exitInfo: vi.fn(() => undefined),
    crashedAgentIds: vi.fn(() => []),
    markStopped: vi.fn(),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, stops };
}

/**
 * The close grace window: closeAgent keeps the process alive for CLOSE_GRACE_MS
 * so undo can bring it back untouched; finalize is the only writer of the
 * Closed list. Pty host is faked; the state file lives in an isolated HOME.
 */
describe('AgentRuntime close grace window', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-grace-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    runtime = new AgentRuntime(store, claudeProvider);
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('beginClose arms the timer without stopping the pty; finalize records, unregisters and removes', () => {
    const { host, stops } = fakeHost();
    runtime.setPtyHost(host);
    store.set(1, makeAgent(1));
    store.set(2, makeAgent(2));
    expect(runtime.beginClose(1, { seatId: 'chair-1', railIndex: 0, ptyBacked: true })).toBe(true);
    expect(store.get(1)?.closing?.seatId).toBe('chair-1');
    expect(stops).toEqual([]);
    expect(runtime.beginClose(1, { railIndex: 0, ptyBacked: true })).toBe(false); // already closing

    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(stops).toEqual([1]);
    const rec = runtime.closedSessions!.list();
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      sessionId: 'sess-1',
      seatId: 'chair-1',
      railIndex: 0,
      customTitle: 'T1',
      terminalName: 'Claude Code #1',
    });
    expect(broadcasts.at(-1)).toMatchObject({ type: 'closedSessions' });
    expect(store.agentOrder).toEqual([2]);
  });

  it("finalize removes a closed lead's teammates (they live inside its process)", () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1, { isTeamLead: true, teamName: 'team' }));
    store.set(
      2,
      makeAgent(2, {
        ptyBacked: undefined,
        terminalRef: undefined,
        leadAgentId: 1,
        teamName: 'team',
        agentName: 'worker',
        sessionId: 'sess-2',
      }),
    );
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(store.has(2)).toBe(false);
    expect(runtime.closedSessions!.list().map((r) => r.sessionId)).toEqual(['sess-1']);
  });

  it('undoClose cancels the timer and clears the snapshot', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    expect(runtime.undoClose(1)?.id).toBe(1);
    expect(store.get(1)?.closing).toBeUndefined();
    expect(runtime.undoClose(1)).toBeNull(); // not closing any more
    vi.advanceTimersByTime(CLOSE_GRACE_MS * 2);
    expect(store.has(1)).toBe(true);
    expect(runtime.closedSessions!.list()).toEqual([]);
  });

  it('an adopted session is dismissed on begin and undismissed on undo; finalize never records it', () => {
    runtime.setPtyHost(fakeHost().host);
    const adopted = makeAgent(3, {
      ptyBacked: undefined,
      isExternal: true,
      terminalRef: undefined,
    });
    store.set(3, adopted);
    runtime.beginClose(3, { railIndex: 0, ptyBacked: false });
    expect(runtime.dismissalTracker.isDismissed(adopted.jsonlFile)).toBe(true);
    runtime.undoClose(3);
    expect(runtime.dismissalTracker.isDismissed(adopted.jsonlFile)).toBe(false);
    runtime.beginClose(3, { railIndex: 0, ptyBacked: false });
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(3)).toBe(false);
    expect(runtime.closedSessions!.list()).toEqual([]);
  });

  it('removeAgent through another path cancels the timer; finalize is a no-op', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    runtime.removeAgent(1); // e.g. external sessionEnd
    expect(runtime.closeGraceTimers.has(1)).toBe(false);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(runtime.closedSessions!.list()).toEqual([]);
  });

  it('dispose inside the window finalizes the record and omits the agent from the persisted list', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    store.set(2, makeAgent(2));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    runtime.dispose();
    const adapter = store.getAdapter()!;
    expect(adapter.loadAgents().map((a) => a.id)).toEqual([2]);
    expect(adapter.loadClosedSessions().map((r) => r.sessionId)).toEqual(['sess-1']);
    expect(adapter.loadAgentOrder()).toEqual([2]);
  });

  it('dispose with a closing ADOPTED agent writes no record', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(3, makeAgent(3, { ptyBacked: undefined, isExternal: true, terminalRef: undefined }));
    runtime.beginClose(3, { railIndex: 0, ptyBacked: false });
    runtime.dispose();
    expect(store.getAdapter()!.loadClosedSessions()).toEqual([]);
  });

  it('an agent appearing for a closed session drops its record', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(runtime.closedSessions!.list()).toHaveLength(1);
    store.set(
      9,
      makeAgent(9, { sessionId: 'sess-1', jsonlFile: '/p/sess-1.jsonl', isExternal: true }),
    );
    expect(runtime.closedSessions!.list()).toEqual([]);
    expect(broadcasts.at(-1)).toMatchObject({ type: 'closedSessions', sessions: [] });
  });
});
