/**
 * Standalone (pty-backed) agent spawn path. The browser SPA's "+ Agent" flow
 * lands here via clientMessageHandler's launchAgent case; VS Code keeps its
 * native-terminal path in adapters/vscode/agentManager.ts.
 *
 * Ported from v2-orchestrator's agentManager.launchNewTerminal, adapted to
 * upstream's AgentRuntime/AgentStateStore split: the pty replaces the VS Code
 * terminal, everything downstream (JSONL poll, file watching, hook routing)
 * mirrors the flow in adapters/vscode/agentManager.ts.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  JSONL_POLL_INTERVAL_MS,
  PTY_SCROLLBACK_MAX_LINES,
} from './constants.js';
import { readNewLines, reassignAgentToFile, startFileWatching } from './fileWatcher.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from './providers/hook/claude/constants.js';
import type { AgentState } from './types.js';

export interface LaunchStandaloneOptions {
  /** Starting folder from the New-agent form. Invalid/absent → launchCwd. */
  folderPath?: string;
  bypassPermissions?: boolean;
  /** Optional display name from the New-agent form. */
  name?: string;
}

export interface LaunchStandaloneDeps {
  store: AgentStateStore;
  /** Must have a pty host injected (setPtyHost); returns null otherwise. */
  runtime: AgentRuntime;
  provider: HookProvider;
  /** The CLI's scan root (process.cwd() at startup) — the default spawn cwd. */
  launchCwd: string;
}

/** Resolve a user-supplied folder string into an absolute path, or undefined.
 *  Expands leading `~`; bare relative paths ("Desktop/proj") resolve against
 *  the home directory, never the server process cwd. Requires the result to
 *  exist as a directory. */
export function resolveDefaultCwd(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;
  const expanded = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1))
    : path.resolve(os.homedir(), trimmed);
  try {
    if (fs.statSync(expanded).isDirectory()) return expanded;
  } catch {
    /* resolved path doesn't exist — ignore */
  }
  console.warn(`[Pixel Agents] Terminal: ignored folder "${raw}" — path not found`);
  return undefined;
}

/** Spawn a pty-backed agent. Returns the new agent id, or null when the
 *  runtime has no pty host / the provider can't build a launch command. */
export function launchAgentStandalone(
  opts: LaunchStandaloneOptions,
  deps: LaunchStandaloneDeps,
): number | null {
  const { store, runtime, provider, launchCwd } = deps;

  const ptyHost = runtime.ptyHost;
  if (!ptyHost) {
    console.warn('[Pixel Agents] launchAgent ignored: no pty host (not running standalone?)');
    return null;
  }
  if (!provider.buildLaunchCommand) {
    console.warn(
      `[Pixel Agents] launchAgent ignored: provider ${provider.id} has no buildLaunchCommand`,
    );
    return null;
  }

  const cwd = resolveDefaultCwd(opts.folderPath) ?? launchCwd;
  const sessionId = crypto.randomUUID();
  const launch = provider.buildLaunchCommand(sessionId, cwd, {
    bypassPermissions: opts.bypassPermissions,
  });

  // Claude's transcript dir for this cwd. getSessionDirs returns the expected
  // path even when it doesn't exist yet (created on Claude's first write).
  const projectDir = provider.getSessionDirs?.(cwd)[0];
  if (!projectDir) {
    console.warn(`[Pixel Agents] launchAgent ignored: no session dir for ${cwd}`);
    return null;
  }

  const id = store.nextAgentId.current++;
  const idx = store.nextTerminalIndex.current++;
  const terminalName = `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`;

  // Launch the shell as a login shell running the claude command, so the
  // user's PATH/rc setup applies — matching what a VS Code terminal would do.
  const shell = process.env.SHELL ?? '/bin/zsh';
  const shellCommand = [launch.command, ...launch.args].join(' ');
  ptyHost.start(id, {
    shell,
    args: ['-l', '-c', shellCommand],
    cwd,
    env: { ...process.env, ...launch.env },
    cols: 80,
    rows: 24,
    scrollbackCapacity: PTY_SCROLLBACK_MAX_LINES,
  });

  // Pre-register the expected JSONL so the project scan won't adopt it as a
  // second (external) agent when it appears.
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  runtime.knownJsonlFiles.add(expectedFile);

  const agent: AgentState = {
    id,
    sessionId,
    // Minimal name-carrier: persist/existingAgents derive terminalName from
    // terminalRef.name. Only `.name`/`.exitStatus` are ever read server-side.
    terminalRef: { name: terminalName } as vscode.Terminal,
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
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
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    ptyBacked: true,
    customTitle: opts.name?.trim() || undefined,
    spawnCwd: cwd,
    bypassPermissions: opts.bypassPermissions || undefined,
  };

  assignPaletteIfNeeded(agent, store);
  store.set(id, agent);
  runtime.activeAgentId.current = id;
  runtime.registerAgent(sessionId, id);
  console.log(`[Pixel Agents] Terminal: Agent ${id} - pty spawned (${terminalName}) in ${cwd}`);

  // A spawn outside the CLI's scan root needs its own project scan so /clear
  // reassignment and teammate detection work there too.
  const launchProjectDir = provider.getSessionDirs?.(launchCwd)[0];
  if (launchProjectDir !== projectDir) {
    runtime.startProjectScan(projectDir);
  }

  // Poll for the transcript to appear, then start watching. Mirrors
  // adapters/vscode/agentManager.ts, including /resume detection: if the
  // terminal starts a different session than expected, adopt the newest
  // untracked JSONL modified after this spawn.
  const createdAt = Date.now();
  let pollCount = 0;
  const pollTimer = setInterval(() => {
    pollCount++;
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        clearInterval(pollTimer);
        runtime.jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          store,
          runtime.fileWatchers,
          runtime.pollingTimers,
          runtime.waitingTimers,
          runtime.permissionTimers,
        );
        readNewLines(id, store, runtime.waitingTimers, runtime.permissionTimers);
      } else if (pollCount > 10) {
        const trackedFiles = new Set([...store.values()].map((a) => path.resolve(a.jsonlFile)));
        const candidates = fs
          .readdirSync(projectDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => {
            const full = path.join(projectDir, f);
            return { file: full, mtime: fs.statSync(full).mtimeMs };
          })
          .filter((c) => !trackedFiles.has(path.resolve(c.file)) && c.mtime > createdAt)
          .sort((a, b) => b.mtime - a.mtime);
        if (candidates.length > 0) {
          console.log(
            `[Pixel Agents] Terminal: Agent ${id} - /resume detected, reassigning to ${path.basename(candidates[0].file)}`,
          );
          clearInterval(pollTimer);
          runtime.jsonlPollTimers.delete(id);
          reassignAgentToFile(
            id,
            candidates[0].file,
            store,
            runtime.fileWatchers,
            runtime.pollingTimers,
            runtime.waitingTimers,
            runtime.permissionTimers,
            () => store.persist(),
          );
        }
      }
    } catch {
      /* projectDir may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  runtime.jsonlPollTimers.set(id, pollTimer);

  store.persist();
  return id;
}
