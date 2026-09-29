import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager } from '../src/pty/ptyManager.js';
import type { PersistedAgent } from '../src/types.js';

function createMockAdapter(initial: PersistedAgent[] = []): StateAdapter {
  let current = initial;
  return {
    loadAgents: () => current,
    saveAgents: (agents) => {
      current = agents;
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: vi.fn<(key: string, value: unknown) => void>(),
  };
}

function makeFakePtyHost() {
  const stopped: Array<{ id: number; exit: { code: number; signal?: string } }> = [];
  const host = {
    start: vi.fn(),
    stop: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn(() => false),
    exitInfo: vi.fn(() => undefined),
    crashedAgentIds: vi.fn(() => stopped.map((s) => s.id)),
    markStopped: vi.fn((id: number, exit: { code: number; signal?: string }) =>
      stopped.push({ id, exit }),
    ),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, stopped };
}

/**
 * A daemon restart kills every in-office pty, but the sessions live on in
 * their transcripts. Persisted pty-backed agents come back as STOPPED
 * characters (dead pty entry → crash glyph + Restart), never auto-resumed.
 */
describe('AgentRuntime -- restore of persisted pty-backed agents', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-restore-pty-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(jsonlPath, '');
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function ptyRecord(overrides: Partial<PersistedAgent> = {}): PersistedAgent {
    return {
      id: 3,
      sessionId: 'sess-pty',
      terminalName: 'Claude Code #1',
      isExternal: false,
      jsonlFile: jsonlPath,
      projectDir: tmpDir,
      ptyBacked: true,
      customTitle: 'Creative Generator',
      spawnCwd: tmpDir,
      bypassPermissions: true,
      palette: 2,
      hueShift: 0,
      ...overrides,
    };
  }

  it('restores a pty agent as stopped: pty-backed, named, session registered, marked dead in the pty host', () => {
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter([ptyRecord()]));
    runtime = new AgentRuntime(store, claudeProvider);
    const { host, stopped } = makeFakePtyHost();
    runtime.setPtyHost(host);

    runtime.restoreExternalAgents();

    const agent = store.get(3);
    expect(agent).toBeDefined();
    expect(agent!.ptyBacked).toBe(true);
    expect(agent!.isExternal).toBe(false);
    expect(agent!.terminalRef?.name).toBe('Claude Code #1');
    expect(agent!.customTitle).toBe('Creative Generator');
    expect(agent!.spawnCwd).toBe(tmpDir);
    expect(agent!.bypassPermissions).toBe(true);
    expect(stopped).toEqual([{ id: 3, exit: { code: 0, signal: 'SIGHUP' } }]);
    expect(host.start).not.toHaveBeenCalled(); // never auto-resumed
    expect(store.nextAgentId.current).toBeGreaterThan(3);
  });

  it('skips a pty agent whose transcript is gone', () => {
    const store = new AgentStateStore();
    store.setAdapter(
      createMockAdapter([ptyRecord({ jsonlFile: path.join(tmpDir, 'missing.jsonl') })]),
    );
    runtime = new AgentRuntime(store, claudeProvider);
    const { host } = makeFakePtyHost();
    runtime.setPtyHost(host);

    runtime.restoreExternalAgents();

    expect(store.has(3)).toBe(false);
  });

  it('without a pty host (VS Code adapter) pty records are ignored as before', () => {
    const store = new AgentStateStore();
    store.setAdapter(createMockAdapter([ptyRecord()]));
    runtime = new AgentRuntime(store, claudeProvider);

    runtime.restoreExternalAgents();

    expect(store.has(3)).toBe(false);
  });
});
