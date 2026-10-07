import * as fs from 'fs';
import * as os from 'os';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PTY_SCROLLBACK_MAX_LINES } from './constants.js';
import { dirExists } from './moveSession.js';
import { ptyEnvironment } from './ptyEnv.js';
import type { AgentState } from './types.js';

export interface ResumeSpawnDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  provider: HookProvider;
  /** The CLI's scan root — the last cwd fallback before the home directory. */
  launchCwd?: string;
}

/**
 * (Re)spawn a pty for an existing pty-backed agent, resuming its session.
 * Shared by restartAgent (dead pane → Restart) and restoreSession (Closed
 * list → Restore) so the two can never drift. Returns false when the runtime
 * has no pty host or the provider cannot build a launch command.
 */
export function spawnResumedPty(agent: AgentState, deps: ResumeSpawnDeps): boolean {
  const { store, runtime, provider, launchCwd } = deps;
  const ptyHost = runtime.ptyHost;
  if (!ptyHost || !provider.buildLaunchCommand || !agent.sessionId) return false;
  // Spawn folder → the transcript's recorded cwd (a restored agent with no
  // persisted folder) → the CLI's launch folder → home.
  const cwd =
    [agent.spawnCwd, provider.transcriptCwd?.(agent.jsonlFile), launchCwd].find(dirExists) ??
    os.homedir();
  // stop() reaps any old worker synchronously, so its late exit is stale
  // (silent) and start() below installs a fresh worker for the same id.
  ptyHost.stop(agent.id);
  const launch = provider.buildLaunchCommand(agent.sessionId, cwd, {
    bypassPermissions: agent.bypassPermissions,
    // Claude refuses --session-id for an id that already has a transcript.
    resume: fs.existsSync(agent.jsonlFile),
  });
  ptyHost.start(agent.id, {
    shell: process.env.SHELL ?? '/bin/zsh',
    args: ['-l', '-c', [launch.command, ...launch.args].join(' ')],
    cwd,
    env: ptyEnvironment(process.env, launch.env),
    cols: 80,
    rows: 24,
    scrollbackCapacity: PTY_SCROLLBACK_MAX_LINES,
  });
  agent.spawnCwd = cwd;
  store.broadcast({ type: 'agentRestarted', id: agent.id });
  return true;
}
