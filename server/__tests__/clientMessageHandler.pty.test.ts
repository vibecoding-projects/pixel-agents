import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { AGENT_TITLE_MAX_LEN } from '../src/constants.js';
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
    scrollback: vi.fn(() => ['line-1', 'line-2']),
    has: vi.fn((id: number) => running.has(id) || exits.has(id)),
    exitInfo: vi.fn((id: number) => exits.get(id)),
    crashedAgentIds: vi.fn(() =>
      [...exits.entries()]
        .filter(([, exit]) => exit.code !== 0 || exit.signal !== undefined)
        .map(([id]) => id),
    ),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, starts, running, exits };
}

describe('clientMessageHandler: standalone pty dispatch', () => {
  let tempHome: string;
  let launchCwd: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ptydispatch-'));
    launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ptydispatch-cwd-'));
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
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(launchCwd, { recursive: true, force: true });
  });

  function makeCtx(host: PtyManager | null, privileged = true): ClientMessageContext {
    runtime = new AgentRuntime(store, claudeProvider);
    if (host) runtime.setPtyHost(host);
    return {
      store,
      runtime,
      cache: null,
      privileged,
      provider: claudeProvider,
      launchCwd,
    };
  }

  const send = (m: Record<string, unknown>) => sent.push(m);

  describe('launchAgent', () => {
    it('privileged: spawns a pty agent and broadcasts agentRenamed for a named spawn', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage({ type: 'launchAgent', name: 'Zed' }, send, ctx);
      expect(store.size).toBe(1);
      expect(starts).toHaveLength(1);
      const renamed = broadcasts.find((b) => b.type === 'agentRenamed');
      expect(renamed).toBeDefined();
      expect(renamed!.customTitle).toBe('Zed');
    });

    it('unprivileged: no-op', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host, false);
      handleClientMessage({ type: 'launchAgent' }, send, ctx);
      expect(store.size).toBe(0);
      expect(starts).toHaveLength(0);
    });

    it('records an existing folderPath in recents MRU and re-sends settingsLoaded', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage({ type: 'launchAgent', folderPath: launchCwd }, send, ctx);
      const adapter = store.getAdapter()!;
      expect(adapter.getSetting<string[]>('pixel-agents.recentAgentFolders', [])).toEqual([
        launchCwd,
      ]);
      const settings = sent.filter((m) => m.type === 'settingsLoaded');
      expect(settings.length).toBeGreaterThan(0);
      expect(settings[settings.length - 1].recentAgentFolders).toEqual([launchCwd]);
    });

    it('unprivileged + bad folderPath: no spawn AND no launchAgentFailed (the refusal must not become a directory-existence oracle)', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host, false);
      handleClientMessage(
        { type: 'launchAgent', folderPath: 'Desktop/not-a-real-dir-xyz' },
        send,
        ctx,
      );
      expect(store.size).toBe(0);
      expect(starts).toHaveLength(0);
      expect(sent.filter((m) => m.type === 'launchAgentFailed')).toHaveLength(0);
    });

    it('refuses to spawn and reports launchAgentFailed when folderPath cannot be resolved', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage(
        { type: 'launchAgent', folderPath: 'Desktop/not-a-real-dir-xyz' },
        send,
        ctx,
      );
      expect(store.size).toBe(0);
      expect(starts).toHaveLength(0);
      const failed = sent.filter((m) => m.type === 'launchAgentFailed');
      expect(failed).toHaveLength(1);
      expect(failed[0].folderPath).toBe('Desktop/not-a-real-dir-xyz');
      expect(typeof failed[0].reason).toBe('string');
    });

    it('spawns in a home-relative folder typed without ~ or a leading slash', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      const dir = path.join(tempHome, 'projects', 'app');
      fs.mkdirSync(dir, { recursive: true });
      handleClientMessage({ type: 'launchAgent', folderPath: 'projects/app' }, send, ctx);
      expect(starts).toHaveLength(1);
      expect(starts[0].opts.cwd).toBe(dir);
      expect(sent.filter((m) => m.type === 'launchAgentFailed')).toHaveLength(0);
    });

    it('does not record a nonexistent folderPath in recents', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage(
        { type: 'launchAgent', folderPath: '/definitely/not/real-xyz' },
        send,
        ctx,
      );
      const adapter = store.getAdapter()!;
      expect(adapter.getSetting<string[]>('pixel-agents.recentAgentFolders', [])).toEqual([]);
    });

    it('MRU: re-picking a folder moves it to the front', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ptydispatch-other-'));
      try {
        handleClientMessage({ type: 'launchAgent', folderPath: launchCwd }, send, ctx);
        handleClientMessage({ type: 'launchAgent', folderPath: other }, send, ctx);
        handleClientMessage({ type: 'launchAgent', folderPath: launchCwd }, send, ctx);
        const adapter = store.getAdapter()!;
        expect(adapter.getSetting<string[]>('pixel-agents.recentAgentFolders', [])).toEqual([
          launchCwd,
          other,
        ]);
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('ptyInput / ptyResize', () => {
    it('privileged: routes write and resize to the pty host', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage({ type: 'ptyInput', id: 3, data: 'ls\n' }, send, ctx);
      handleClientMessage({ type: 'ptyResize', id: 3, cols: 120, rows: 40 }, send, ctx);
      expect(host.write).toHaveBeenCalledWith(3, 'ls\n');
      expect(host.resize).toHaveBeenCalledWith(3, 120, 40);
    });

    it('unprivileged: ptyInput is a no-op', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host, false);
      handleClientMessage({ type: 'ptyInput', id: 3, data: 'rm -rf /\n' }, send, ctx);
      expect(host.write).not.toHaveBeenCalled();
    });
  });

  describe('terminalPaneReady', () => {
    it('replies with scrollback point-to-point, not broadcast', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      ctx.runtime!.ptyHost!.start(5, {} as PtyStartOptions); // mark id 5 as running
      handleClientMessage({ type: 'terminalPaneReady', id: 5 }, send, ctx);
      const reply = sent.find((m) => m.type === 'ptyScrollback');
      expect(reply).toBeDefined();
      expect(reply!.id).toBe(5);
      expect(reply!.lines).toEqual(['line-1', 'line-2']);
      expect(broadcasts.find((b) => b.type === 'ptyScrollback')).toBeUndefined();
    });

    it('no reply for an unknown id', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage({ type: 'terminalPaneReady', id: 99 }, send, ctx);
      expect(sent.find((m) => m.type === 'ptyScrollback')).toBeUndefined();
    });

    it('a DEAD retained agent replies with scrollback plus a synthetic ptyExit', () => {
      const { host, exits } = makeFakePtyHost();
      const ctx = makeCtx(host);
      exits.set(7, { code: 137, signal: 'SIGKILL' }); // retained after crash
      handleClientMessage({ type: 'terminalPaneReady', id: 7 }, send, ctx);
      const scrollbackIdx = sent.findIndex((m) => m.type === 'ptyScrollback');
      const exitIdx = sent.findIndex((m) => m.type === 'ptyExit');
      expect(scrollbackIdx).toBeGreaterThanOrEqual(0);
      expect(exitIdx).toBeGreaterThan(scrollbackIdx); // marker lands after replay
      expect(sent[exitIdx]).toMatchObject({ id: 7, code: 137, signal: 'SIGKILL' });
      expect(broadcasts.find((b) => b.type === 'ptyExit')).toBeUndefined(); // point-to-point
    });
  });

  describe('restartAgent', () => {
    it('stops then restarts with the same sessionId in spawnCwd; broadcasts agentRestarted', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      store.set(
        4,
        createTestAgent({ id: 4, sessionId: 'sess-4', ptyBacked: true, spawnCwd: launchCwd }),
      );
      handleClientMessage({ type: 'restartAgent', id: 4 }, send, ctx);
      expect(host.stop).toHaveBeenCalledWith(4);
      expect(starts).toHaveLength(1);
      expect(starts[0].id).toBe(4);
      expect(starts[0].opts.cwd).toBe(launchCwd);
      expect(starts[0].opts.args.join(' ')).toContain('sess-4');
      expect(broadcasts.find((b) => b.type === 'agentRestarted')?.id).toBe(4);
    });

    it('restarts with --resume when the transcript exists, --session-id when it does not', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      const transcript = path.join(launchCwd, 'sess-1.jsonl');
      fs.writeFileSync(transcript, '{"type":"user"}\n');
      store.set(
        1,
        createTestAgent({ id: 1, ptyBacked: true, spawnCwd: launchCwd, jsonlFile: transcript }),
      );
      handleClientMessage({ type: 'restartAgent', id: 1 }, send, ctx);
      expect(starts.at(-1)!.opts.args.at(-1)).toContain('claude --resume sess-1');

      store.set(
        2,
        createTestAgent({
          id: 2,
          sessionId: 'sess-2',
          ptyBacked: true,
          spawnCwd: launchCwd,
          jsonlFile: path.join(launchCwd, 'missing.jsonl'),
        }),
      );
      handleClientMessage({ type: 'restartAgent', id: 2 }, send, ctx);
      expect(starts.at(-1)!.opts.args.at(-1)).toContain('claude --session-id sess-2');
    });

    it('restart re-applies the recorded bypassPermissions flag', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      handleClientMessage(
        { type: 'launchAgent', bypassPermissions: true, name: 'Bypasser' },
        send,
        ctx,
      );
      expect(starts).toHaveLength(1);
      expect(starts[0].opts.args.join(' ')).toContain('--dangerously-skip-permissions');
      const id = starts[0].id;
      handleClientMessage({ type: 'restartAgent', id }, send, ctx);
      expect(starts).toHaveLength(2);
      expect(starts[1].opts.args.join(' ')).toContain('--dangerously-skip-permissions');
    });

    it('ignores restart for a non-pty agent', () => {
      const { host, starts } = makeFakePtyHost();
      const ctx = makeCtx(host);
      store.set(6, createTestAgent({ id: 6, sessionId: 'sess-6' }));
      handleClientMessage({ type: 'restartAgent', id: 6 }, send, ctx);
      expect(starts).toHaveLength(0);
    });
  });

  describe('renameAgent', () => {
    it('privileged: trims, persists, and broadcasts agentRenamed', () => {
      const ctx = makeCtx(null);
      store.set(1, createTestAgent({ id: 1 }));
      handleClientMessage({ type: 'renameAgent', id: 1, customTitle: '  Budget bot  ' }, send, ctx);
      expect(store.get(1)!.customTitle).toBe('Budget bot');
      expect(broadcasts.at(-1)).toEqual({ type: 'agentRenamed', id: 1, customTitle: 'Budget bot' });
      expect(store.loadPersistedAgents().find((a) => a.id === 1)?.customTitle).toBe('Budget bot');
    });

    it('whitespace-only clears the title and broadcasts an empty string', () => {
      const ctx = makeCtx(null);
      store.set(1, createTestAgent({ id: 1, customTitle: 'Old' }));
      handleClientMessage({ type: 'renameAgent', id: 1, customTitle: '   ' }, send, ctx);
      expect(store.get(1)!.customTitle).toBeUndefined();
      expect(broadcasts.at(-1)).toEqual({ type: 'agentRenamed', id: 1, customTitle: '' });
      expect(store.loadPersistedAgents().find((a) => a.id === 1)?.customTitle).toBeUndefined();
    });

    it('truncates to AGENT_TITLE_MAX_LEN after trimming', () => {
      const ctx = makeCtx(null);
      store.set(1, createTestAgent({ id: 1 }));
      handleClientMessage(
        { type: 'renameAgent', id: 1, customTitle: ' ' + 'x'.repeat(200) },
        send,
        ctx,
      );
      expect(store.get(1)!.customTitle).toBe('x'.repeat(AGENT_TITLE_MAX_LEN));
    });

    it('works for external (adopted) agents too', () => {
      const ctx = makeCtx(null);
      store.set(4, createTestAgent({ id: 4, isExternal: true }));
      handleClientMessage({ type: 'renameAgent', id: 4, customTitle: 'Songer' }, send, ctx);
      expect(store.get(4)!.customTitle).toBe('Songer');
    });

    it('unprivileged: no change, no broadcast', () => {
      const ctx = makeCtx(null, false);
      store.set(1, createTestAgent({ id: 1, customTitle: 'Keep' }));
      handleClientMessage({ type: 'renameAgent', id: 1, customTitle: 'Nope' }, send, ctx);
      expect(store.get(1)!.customTitle).toBe('Keep');
      expect(broadcasts.find((b) => b.type === 'agentRenamed')).toBeUndefined();
    });

    it('unknown id or non-string title: no-op', () => {
      const ctx = makeCtx(null);
      handleClientMessage({ type: 'renameAgent', id: 99, customTitle: 'x' }, send, ctx);
      store.set(1, createTestAgent({ id: 1, customTitle: 'Keep' }));
      handleClientMessage({ type: 'renameAgent', id: 1, customTitle: 42 }, send, ctx);
      expect(store.get(1)!.customTitle).toBe('Keep');
      expect(broadcasts.find((b) => b.type === 'agentRenamed')).toBeUndefined();
    });
  });

  describe('moveSessionHere', () => {
    it('privileged: dispatches to moveSessionHere and reports a refusal point-to-point', async () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      store.set(4, createTestAgent({ id: 4, isExternal: true, jsonlFile: '/nope/gone.jsonl' }));
      handleClientMessage({ type: 'moveSessionHere', id: 4 }, send, ctx);
      await new Promise((r) => setTimeout(r, 10));
      expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
    });

    it('unprivileged: no-op', async () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host, false);
      store.set(4, createTestAgent({ id: 4, isExternal: true, jsonlFile: '/nope/gone.jsonl' }));
      handleClientMessage({ type: 'moveSessionHere', id: 4 }, send, ctx);
      await new Promise((r) => setTimeout(r, 10));
      expect(sent).toHaveLength(0);
    });
  });

  describe('existingAgents teammateAgents', () => {
    it('lists agents that have a leadAgentId', () => {
      const ctx = makeCtx(null);
      store.set(1, createTestAgent({ id: 1 }));
      store.set(
        2,
        createTestAgent({ id: 2, sessionId: 'sess-2', leadAgentId: 1, agentName: 'researcher' }),
      );
      handleClientMessage({ type: 'webviewReady' }, send, ctx);
      const existing = sent.find((m) => m.type === 'existingAgents')!;
      expect(existing.teammateAgents).toEqual({ 2: true });
    });
  });

  describe('acknowledgeCrash', () => {
    it('privileged: broadcasts crashAcknowledged', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host, true);
      handleClientMessage({ type: 'acknowledgeCrash', id: 9 }, send, ctx);
      expect(broadcasts.find((b) => b.type === 'crashAcknowledged')).toEqual({
        type: 'crashAcknowledged',
        id: 9,
      });
    });

    it('unprivileged: ignored (no broadcast)', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host, false);
      handleClientMessage({ type: 'acknowledgeCrash', id: 9 }, send, ctx);
      expect(broadcasts.find((b) => b.type === 'crashAcknowledged')).toBeUndefined();
    });
  });

  describe('webviewReady reconnect payloads', () => {
    it('existingAgents carries ptyBackedAgents and customTitles', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      store.set(
        2,
        createTestAgent({ id: 2, sessionId: 'sess-2', ptyBacked: true, customTitle: 'Ada' }),
      );
      store.set(3, createTestAgent({ id: 3, sessionId: 'sess-3' }));
      handleClientMessage({ type: 'webviewReady' }, send, ctx);
      const existing = sent.find((m) => m.type === 'existingAgents');
      expect(existing).toBeDefined();
      expect(existing!.ptyBackedAgents).toEqual({ 2: true });
      expect(existing!.customTitles).toEqual({ 2: 'Ada' });
    });

    it('existingAgents includes terminalNames and, when privileged, crashedAgentIds', () => {
      const { host, exits } = makeFakePtyHost();
      const ctx = makeCtx(host, true);
      store.set(
        2,
        createTestAgent({
          id: 2,
          sessionId: 'sess-2',
          terminalRef: { name: 'Claude Code #1' } as vscode.Terminal,
        }),
      );
      exits.set(9, { code: 1 }); // a crashed, retained worker (unrelated agent id)
      handleClientMessage({ type: 'webviewReady' }, send, ctx);
      const existing = sent.find((m) => m.type === 'existingAgents');
      expect(existing).toBeDefined();
      expect(existing!.terminalNames).toEqual({ 2: 'Claude Code #1' });
      expect(existing!.crashedAgentIds).toEqual([9]);
    });

    it('existingAgents reply omits crashedAgentIds for unprivileged connections', () => {
      const { host, exits } = makeFakePtyHost();
      const ctx = makeCtx(host, false);
      exits.set(9, { code: 1 });
      handleClientMessage({ type: 'webviewReady' }, send, ctx);
      const existing = sent.find((m) => m.type === 'existingAgents');
      expect(existing).toBeDefined();
      expect(existing!.crashedAgentIds).toBeUndefined();
    });

    it('settingsLoaded includes recentAgentFolders', () => {
      const { host } = makeFakePtyHost();
      const ctx = makeCtx(host);
      store.getAdapter()!.setSetting('pixel-agents.recentAgentFolders', ['/a']);
      handleClientMessage({ type: 'webviewReady' }, send, ctx);
      const settings = sent.find((m) => m.type === 'settingsLoaded');
      expect(settings!.recentAgentFolders).toEqual(['/a']);
    });
  });
});
