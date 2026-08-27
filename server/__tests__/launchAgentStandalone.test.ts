import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { launchAgentStandalone, resolveDefaultCwd } from '../src/launchAgentStandalone.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager, PtyStartOptions } from '../src/pty/ptyManager.js';

function makeFakePtyHost() {
  const starts: Array<{ id: number; opts: PtyStartOptions }> = [];
  const host = {
    start: vi.fn((id: number, opts: PtyStartOptions) => void starts.push({ id, opts })),
    stop: vi.fn(),
    disposeAll: vi.fn(),
    has: vi.fn(() => true),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
  };
  return { host: host as unknown as PtyManager, starts };
}

describe('launchAgentStandalone', () => {
  let tempHome: string;
  let launchCwd: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-test-'));
    launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-cwd-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(launchCwd, { recursive: true, force: true });
  });

  function makeDeps(host: PtyManager | null) {
    runtime = new AgentRuntime(store, claudeProvider);
    if (host) runtime.setPtyHost(host);
    return { store, runtime, provider: claudeProvider, launchCwd };
  }

  it('spawns one pty-backed agent with customTitle and --session-id', () => {
    const { host, starts } = makeFakePtyHost();
    const id = launchAgentStandalone({ name: '  My Agent  ' }, makeDeps(host));

    expect(id).not.toBeNull();
    const agent = store.get(id!);
    expect(agent).toBeDefined();
    expect(agent!.ptyBacked).toBe(true);
    expect(agent!.isExternal).toBe(false);
    expect(agent!.customTitle).toBe('My Agent');
    expect(agent!.spawnCwd).toBe(launchCwd);

    expect(starts).toHaveLength(1);
    expect(starts[0].id).toBe(id);
    expect(starts[0].opts.cwd).toBe(launchCwd);
    // The shell -c command carries claude --session-id <uuid>
    const shellCmd = starts[0].opts.args.join(' ');
    expect(shellCmd).toContain('--session-id');
    expect(shellCmd).toContain(agent!.sessionId);
  });

  it('pre-registers the expected JSONL path in knownJsonlFiles', () => {
    const { host } = makeFakePtyHost();
    const deps = makeDeps(host);
    const id = launchAgentStandalone({}, deps);

    const agent = store.get(id!)!;
    expect(agent.jsonlFile.endsWith(`${agent.sessionId}.jsonl`)).toBe(true);
    expect(deps.runtime.knownJsonlFiles.has(agent.jsonlFile)).toBe(true);
  });

  it('falls back to launchCwd when folderPath is invalid', () => {
    const { host, starts } = makeFakePtyHost();
    const id = launchAgentStandalone(
      { folderPath: '/definitely/not/a/real/dir-xyz' },
      makeDeps(host),
    );
    expect(id).not.toBeNull();
    expect(starts[0].opts.cwd).toBe(launchCwd);
    expect(store.get(id!)!.spawnCwd).toBe(launchCwd);
  });

  it('returns null and creates no agent when no pty host is injected', () => {
    const id = launchAgentStandalone({}, makeDeps(null));
    expect(id).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('resolveDefaultCwd', () => {
  it('returns undefined for empty/blank input', () => {
    expect(resolveDefaultCwd(undefined)).toBeUndefined();
    expect(resolveDefaultCwd('   ')).toBeUndefined();
  });

  it('returns an existing directory as-is', () => {
    expect(resolveDefaultCwd(os.tmpdir())).toBe(os.tmpdir());
  });

  it('returns undefined for a non-existent path', () => {
    expect(resolveDefaultCwd('/definitely/not/a/real/dir-xyz')).toBeUndefined();
  });

  describe('relative paths', () => {
    let tempHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
      tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resolve-home-'));
      originalHome = process.env.HOME;
      process.env.HOME = tempHome;
    });

    afterEach(() => {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    });

    it('resolves a bare relative path against the home directory', () => {
      const dir = path.join(tempHome, 'Desktop', 'fs-songer');
      fs.mkdirSync(dir, { recursive: true });
      expect(resolveDefaultCwd('Desktop/fs-songer')).toBe(dir);
    });

    it('expands ~/sub against the home directory', () => {
      const dir = path.join(tempHome, 'wk');
      fs.mkdirSync(dir);
      expect(resolveDefaultCwd('~/wk')).toBe(dir);
    });

    it('resolves "." against the home directory, not the process cwd', () => {
      expect(resolveDefaultCwd('.')).toBe(tempHome);
    });

    it('returns undefined when the home-relative path does not exist', () => {
      expect(resolveDefaultCwd('Desktop/not-there-xyz')).toBeUndefined();
    });
  });
});
