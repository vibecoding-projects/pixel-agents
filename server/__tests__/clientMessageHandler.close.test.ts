import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { CLOSE_GRACE_MS } from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { moveRefusalReason } from '../src/moveSession.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager, PtyStartOptions } from '../src/pty/ptyManager.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function ptyAgent(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return createTestAgent({
    id,
    sessionId: `sess-${id}`,
    jsonlFile: `/test/sess-${id}.jsonl`,
    ptyBacked: true,
    terminalRef: { name: `Claude Code #${id}` } as vscode.Terminal,
    customTitle: `T${id}`,
    ...overrides,
  });
}

function makeFakePtyHost() {
  const running = new Set<number>();
  const starts: Array<{ id: number; opts: PtyStartOptions }> = [];
  const exits = new Map<number, { code: number; signal?: string }>();
  const host = {
    start: vi.fn((id: number, opts: PtyStartOptions) => {
      running.add(id);
      exits.delete(id);
      starts.push({ id, opts });
    }),
    stop: vi.fn((id: number) => {
      running.delete(id);
      exits.delete(id);
    }),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn((id: number) => running.has(id) || exits.has(id)),
    exitInfo: vi.fn((id: number) => exits.get(id)),
    crashedAgentIds: vi.fn(() =>
      [...exits.entries()]
        .filter(([, exit]) => exit.code !== 0 || exit.signal !== undefined)
        .map(([id]) => id),
    ),
    markStopped: vi.fn((id: number, exit: { code: number; signal?: string }) =>
      exits.set(id, exit),
    ),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, starts, running, exits };
}

/**
 * closeAgent with the grace window, undoClose, forgetClosedSession,
 * reorderAgents and the handshake fields they add. Fake pty host, fake timers,
 * isolated HOME for the state file.
 */
describe('clientMessageHandler: close grace window', () => {
  let tempHome: string;
  let launchCwd: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-close-'));
    launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-close-cwd-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.useRealTimers();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(launchCwd, { recursive: true, force: true });
  });

  function makeCtx(host: PtyManager | null): ClientMessageContext {
    runtime = new AgentRuntime(store, claudeProvider);
    if (host) runtime.setPtyHost(host);
    return { store, runtime, cache: null, privileged: true, provider: claudeProvider, launchCwd };
  }
  const unprivileged = (ctx: ClientMessageContext): ClientMessageContext => ({
    ...ctx,
    privileged: false,
  });
  const send = (m: Record<string, unknown>) => sent.push(m);

  it('snapshots seat + rail index + kind, broadcasts agentClosing and keeps the pty alive', () => {
    const { host, running } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.getAdapter()!.saveSeats({ '1': { seatId: 'chair-7' } });
    store.set(1, ptyAgent(1));
    store.set(2, ptyAgent(2));
    running.add(1);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    expect(store.get(1)?.closing).toMatchObject({
      seatId: 'chair-7',
      railIndex: 0,
      ptyBacked: true,
    });
    expect(broadcasts).toContainEqual({ type: 'agentClosing', id: 1, graceMs: CLOSE_GRACE_MS });
    expect(running.has(1)).toBe(true);
  });

  it('is ignored for teammates, spawns, closing agents, in-flight moves and unprivileged clients', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1, { leadAgentId: 5 }));
    store.set(2, ptyAgent(2, { spawnToolUseId: 'toolu_1' }));
    store.set(3, ptyAgent(3, { moveInFlight: true }));
    store.set(4, ptyAgent(4));
    store.set(5, ptyAgent(5));
    for (const id of [1, 2, 3]) handleClientMessage({ type: 'closeAgent', id }, send, ctx);
    handleClientMessage({ type: 'closeAgent', id: 4 }, send, ctx);
    handleClientMessage({ type: 'closeAgent', id: 4 }, send, ctx);
    handleClientMessage({ type: 'closeAgent', id: 5 }, send, unprivileged(ctx));
    expect(broadcasts.filter((b) => b.type === 'agentClosing')).toEqual([
      { type: 'agentClosing', id: 4, graceMs: CLOSE_GRACE_MS },
    ]);
    expect(store.get(5)?.closing).toBeUndefined();
  });

  it('without a pty host (no standalone) it keeps the immediate dismiss + remove', () => {
    const ctx = makeCtx(null);
    store.set(1, createTestAgent({ id: 1, isExternal: true }));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    expect(store.has(1)).toBe(false);
    expect(broadcasts.some((b) => b.type === 'agentClosing')).toBe(false);
  });

  it('seat snapshot survives a saveAgentSeats inside the window', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.getAdapter()!.saveSeats({ '1': { seatId: 'chair-7' } });
    store.set(1, ptyAgent(1));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    handleClientMessage({ type: 'saveAgentSeats', seats: {} }, send, ctx); // webview dropped the character
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    const created = broadcasts.find((b) => b.type === 'agentCreated');
    expect(created).toMatchObject({ id: 1, seatId: 'chair-7', restored: true, customTitle: 'T1' });
  });

  it('undoClose re-sends live state (team info, tools, waiting, context, crash)', () => {
    const { host, exits } = makeFakePtyHost();
    const ctx = makeCtx(host);
    const a = ptyAgent(1, { isTeamLead: true, isWaiting: true, contextTokens: 10 });
    a.activeToolStatuses.set('t1', 'Bash: ls');
    a.activeToolNames.set('t1', 'Bash');
    store.set(1, a);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    exits.set(1, { code: 1 }); // pty died inside the window
    broadcasts.length = 0;
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    const types = broadcasts.map((b) => b.type);
    expect(types[0]).toBe('agentCreated');
    expect(types).toEqual(
      expect.arrayContaining([
        'agentTeamInfo',
        'agentToolStart',
        'agentStatus',
        'agentContextUsage',
        'agentCrashed',
      ]),
    );
    expect(store.get(1)?.closing).toBeUndefined();
  });

  it('undoClose on an adopted session clears the dismissal and re-sends nothing pty-specific', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    const ext = createTestAgent({ id: 1, isExternal: true, jsonlFile: '/test/ext.jsonl' });
    store.set(1, ext);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    expect(runtime!.dismissalTracker.isDismissed('/test/ext.jsonl')).toBe(true);
    broadcasts.length = 0;
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    expect(runtime!.dismissalTracker.isDismissed('/test/ext.jsonl')).toBe(false);
    expect(broadcasts[0]).toMatchObject({
      type: 'agentCreated',
      id: 1,
      restored: true,
      isExternal: true,
    });
    expect(broadcasts.some((b) => b.type === 'agentCrashed')).toBe(false);
  });

  it('undoClose for a non-closing agent and unprivileged undo emit nothing', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1));
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    expect(broadcasts).toEqual([]);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    broadcasts.length = 0;
    handleClientMessage({ type: 'undoClose', id: 1 }, send, unprivileged(ctx));
    expect(broadcasts).toEqual([]);
    expect(store.get(1)?.closing).toBeDefined();
  });

  it('finalize removes, unregisters, records and broadcasts closedSessions', () => {
    const { host, running } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.set(1, ptyAgent(1));
    running.add(1);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(running.has(1)).toBe(false);
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'closedSessions',
      sessions: [{ sessionId: 'sess-1', terminalName: 'Claude Code #1', customTitle: 'T1' }],
    });
  });

  it('adopted sessions never enter the Closed list', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, createTestAgent({ id: 1, isExternal: true, jsonlFile: '/test/ext.jsonl' }));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(broadcasts.some((b) => b.type === 'closedSessions')).toBe(false);
  });

  it('forgetClosedSession drops the record', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    handleClientMessage({ type: 'forgetClosedSession', sessionId: 'sess-1' }, send, ctx);
    expect(broadcasts.at(-1)).toEqual({ type: 'closedSessions', sessions: [] });
  });

  it('reorderAgents sanitizes and broadcasts agentOrder; unprivileged is ignored', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1));
    store.set(2, ptyAgent(2));
    store.set(3, ptyAgent(3));
    handleClientMessage({ type: 'reorderAgents', order: [3, 42, 1] }, send, ctx);
    expect(broadcasts.at(-1)).toEqual({ type: 'agentOrder', order: [3, 1, 2] });
    handleClientMessage({ type: 'reorderAgents', order: [1, 2, 3] }, send, unprivileged(ctx));
    expect(store.agentOrder).toEqual([3, 1, 2]);
  });

  it('existingAgents carries agentOrder, closedSessions and closingAgents, and skips the closing agent in the resend', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1, { isWaiting: true }));
    store.set(2, ptyAgent(2));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(1_000);
    sent.length = 0;
    handleClientMessage({ type: 'webviewReady' }, send, ctx);
    const existing = sent.find((m) => m.type === 'existingAgents')!;
    expect(existing.agentOrder).toEqual([1, 2]);
    expect(existing.closedSessions).toEqual([]);
    expect(existing.closingAgents).toEqual({ '1': CLOSE_GRACE_MS - 1_000 });
    expect(sent.some((m) => m.type === 'agentStatus' && m.id === 1)).toBe(false);
  });

  it('moveRefusalReason refuses a closing agent', () => {
    const a = createTestAgent({
      id: 1,
      isExternal: true,
      closing: { since: 0, railIndex: 0, ptyBacked: false },
    });
    expect(moveRefusalReason(a, true)).toMatch(/closing/i);
  });
});
