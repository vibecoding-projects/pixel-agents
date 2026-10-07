import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager, PtyStartOptions } from '../src/pty/ptyManager.js';
import { spawnResumedPty } from '../src/spawnResumedPty.js';
import type { AgentState } from '../src/types.js';

function ptyAgent(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `sess-${id}`,
    terminalRef: { name: `Claude Code #${id}` } as vscode.Terminal,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: `/test/sess-${id}.jsonl`,
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
    ...overrides,
  } as AgentState;
}

function makeFakePtyHost() {
  const running = new Set<number>();
  const starts: Array<{ id: number; opts: PtyStartOptions }> = [];
  const host = {
    start: vi.fn((id: number, opts: PtyStartOptions) => {
      running.add(id);
      starts.push({ id, opts });
    }),
    stop: vi.fn((id: number) => running.delete(id)),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn((id: number) => running.has(id)),
    exitInfo: vi.fn(() => undefined),
    crashedAgentIds: vi.fn(() => []),
    markStopped: vi.fn(),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, starts, running };
}

/** The one resume-spawn path shared by restartAgent and restoreSession. */
describe('spawnResumedPty', () => {
  let tempHome: string;
  let launchCwd: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resume-'));
    launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resume-cwd-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(launchCwd, { recursive: true, force: true });
  });

  it('stops the old worker, resumes when the transcript exists, broadcasts agentRestarted', () => {
    const { host, starts, running } = makeFakePtyHost();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.setPtyHost(host);
    const jsonl = path.join(launchCwd, 'sess-1.jsonl');
    fs.writeFileSync(jsonl, '');
    const agent = ptyAgent(1, { jsonlFile: jsonl, spawnCwd: launchCwd });
    store.set(1, agent);
    running.add(1);
    expect(spawnResumedPty(agent, { store, runtime, provider: claudeProvider, launchCwd })).toBe(
      true,
    );
    expect(host.stop).toHaveBeenCalledWith(1);
    expect(starts).toHaveLength(1);
    expect(starts[0].opts.args.join(' ')).toContain('--resume sess-1');
    expect(starts[0].opts.cwd).toBe(launchCwd);
    expect(broadcasts.at(-1)).toEqual({ type: 'agentRestarted', id: 1 });
  });

  it('uses --session-id when the transcript is gone and falls back to launchCwd', () => {
    const { host, starts } = makeFakePtyHost();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.setPtyHost(host);
    const agent = ptyAgent(1, { jsonlFile: '/nope/sess-1.jsonl', spawnCwd: '/nope' });
    store.set(1, agent);
    spawnResumedPty(agent, { store, runtime, provider: claudeProvider, launchCwd });
    expect(starts[0].opts.args.join(' ')).toContain('--session-id sess-1');
    expect(starts[0].opts.cwd).toBe(launchCwd);
  });

  it('returns false without a pty host', () => {
    runtime = new AgentRuntime(store, claudeProvider);
    expect(
      spawnResumedPty(ptyAgent(1), { store, runtime, provider: claudeProvider, launchCwd }),
    ).toBe(false);
  });
});
