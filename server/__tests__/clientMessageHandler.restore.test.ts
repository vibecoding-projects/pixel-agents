import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { agentCreatedMessage } from '../src/agentCreatedMessage.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { CLOSE_GRACE_MS } from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
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
 * restoreSession: a Closed-list entry comes back as a NEW agent through the
 * shared resume-spawn path. agentCreated reaches clients through the store's
 * agentAdded event (httpServer's socket closure), so the harness mirrors it.
 */
describe('clientMessageHandler: restoreSession', () => {
  let tempHome: string;
  let launchCwd: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-'));
    launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-cwd-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    store.on('agentAdded', (id, a, extra) => broadcasts.push(agentCreatedMessage(id, a, extra)));
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
  const send = (m: Record<string, unknown>) => sent.push(m);
  function closeAndElapse(ctx: ClientMessageContext, id: number) {
    handleClientMessage({ type: 'closeAgent', id }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
  }

  it('spawns a NEW id with --resume, emits one agentCreated with seat+restored, re-inserts at the old rail index, writes the seat', () => {
    const { host, starts } = makeFakePtyHost();
    const ctx = makeCtx(host);
    const jsonl = path.join(launchCwd, 'sess-1.jsonl');
    fs.writeFileSync(jsonl, '');
    store.getAdapter()!.saveSeats({ '1': { seatId: 'chair-3' } });
    store.set(
      1,
      ptyAgent(1, { jsonlFile: jsonl, projectDir: launchCwd, spawnCwd: launchCwd, palette: 4 }),
    );
    store.set(2, ptyAgent(2));
    store.set(3, ptyAgent(3));
    // Seeded ids bypass the allocator; mirror its invariant (always past every id).
    store.nextAgentId.current = 4;
    closeAndElapse(ctx, 1);
    broadcasts.length = 0;
    handleClientMessage({ type: 'restoreSession', sessionId: 'sess-1' }, send, ctx);
    const created = broadcasts.filter((b) => b.type === 'agentCreated');
    expect(created).toHaveLength(1);
    const newId = created[0].id as number;
    expect(newId).not.toBe(1);
    expect(created[0]).toMatchObject({
      seatId: 'chair-3',
      restored: true,
      customTitle: 'T1',
      palette: 4,
      ptyBacked: true,
      terminalName: 'Claude Code #1',
    });
    expect(starts.at(-1)!.opts.args.join(' ')).toContain('--resume sess-1');
    expect(broadcasts.find((b) => b.type === 'closedSessions')).toEqual({
      type: 'closedSessions',
      sessions: [],
    });
    expect(broadcasts.at(-1)).toEqual({ type: 'agentOrder', order: [newId, 2, 3] });
    expect(store.getAdapter()!.loadSeats()[String(newId)]?.seatId).toBe('chair-3');
    expect(store.get(newId)?.sessionId).toBe('sess-1');
    expect(store.get(newId)?.fileOffset).toBe(0); // empty transcript → end of file is 0
  });

  it('refuses (drops the record, spawns nothing) when the session is live again', () => {
    const { host, starts } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.set(1, ptyAgent(1));
    closeAndElapse(ctx, 1);
    expect(runtime!.closedSessions!.list()).toHaveLength(1);
    // Came back from outside: adopted under a new id. agentAdded drops the record.
    store.set(
      7,
      createTestAgent({
        id: 7,
        sessionId: 'sess-1',
        jsonlFile: '/test/sess-1.jsonl',
        isExternal: true,
      }),
    );
    expect(runtime!.closedSessions!.list()).toEqual([]);
    const before = starts.length;
    handleClientMessage({ type: 'restoreSession', sessionId: 'sess-1' }, send, ctx);
    expect(starts.length).toBe(before);
  });

  it('a missing transcript still spawns (fresh session) and polls for the file', () => {
    const { host, starts } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.set(
      1,
      ptyAgent(1, { jsonlFile: path.join(launchCwd, 'gone.jsonl'), projectDir: launchCwd }),
    );
    closeAndElapse(ctx, 1);
    handleClientMessage({ type: 'restoreSession', sessionId: 'sess-1' }, send, ctx);
    expect(starts.at(-1)!.opts.args.join(' ')).toContain('--session-id sess-1');
    const newId = [...store.keys()][0];
    expect(runtime!.jsonlPollTimers.has(newId)).toBe(true);
  });

  it('a throwing spawn leaves a stopped agent with the crash glyph (record already gone)', () => {
    const { host } = makeFakePtyHost();
    (host.start as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed');
    });
    const ctx = makeCtx(host);
    store.set(1, ptyAgent(1));
    closeAndElapse(ctx, 1);
    expect(() =>
      handleClientMessage({ type: 'restoreSession', sessionId: 'sess-1' }, send, ctx),
    ).not.toThrow();
    const newId = [...store.keys()][0];
    expect(host.markStopped).toHaveBeenCalledWith(newId, expect.objectContaining({ code: 1 }));
    expect(broadcasts.some((b) => b.type === 'agentCrashed' && b.id === newId)).toBe(true);
    expect(runtime!.closedSessions!.list()).toEqual([]);
  });

  it('unknown sessionId and unprivileged are no-ops', () => {
    const { host, starts } = makeFakePtyHost();
    const ctx = makeCtx(host);
    handleClientMessage({ type: 'restoreSession', sessionId: 'nope' }, send, ctx);
    store.set(1, ptyAgent(1));
    closeAndElapse(ctx, 1);
    handleClientMessage({ type: 'restoreSession', sessionId: 'sess-1' }, send, {
      ...ctx,
      privileged: false,
    });
    expect(starts).toHaveLength(0);
    expect(runtime!.closedSessions!.list()).toHaveLength(1);
  });
});
