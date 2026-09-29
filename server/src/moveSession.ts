/**
 * Move an adopted (external) agent's session into an in-office pty.
 *
 * Order matters and every failure leaves the agent exactly as it was:
 *   guards → locate the outside process → latch → stop it → spawn
 *   `claude --resume` → flip the agent to pty-backed → broadcast sessionMoved.
 * The latch (`pendingHandoff` + `pendingClear`) is set BEFORE the signal so the
 * outgoing process's SessionEnd(reason=other) is treated as a handoff by the
 * hook handler instead of removing the character.
 */
import * as fs from 'fs';
import type * as vscode from 'vscode';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  MOVE_HANDOFF_GRACE_MS,
  MOVE_KILL_TIMEOUT_MS,
  MOVE_POLL_INTERVAL_MS,
  MOVE_TERMINATE_TIMEOUT_MS,
  PTY_SCROLLBACK_MAX_LINES,
} from './constants.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from './providers/hook/claude/constants.js';
import { hasInlineTeammates } from './teamUtils.js';
import type { AgentState } from './types.js';

export interface MoveSessionDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  provider: HookProvider;
  /** The CLI's scan root — last-resort cwd for the resumed process. */
  launchCwd: string;
  /** Point-to-point channel to the requester (moveSessionFailed). */
  send: (m: Record<string, unknown>) => void;
  /** Test seams; default to process.kill / kill(pid, 0) / setTimeout. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Why an agent cannot be moved, or null when it can. Pure; exported for tests
 *  and for the client-message dispatch's cheap pre-check. */
export function moveRefusalReason(
  agent: AgentState | undefined,
  hasTranscript: boolean,
  hasLiveInlineTeammates = false,
): string | null {
  if (!agent) return 'Unknown agent.';
  if (agent.moveInFlight) return 'A move is already in progress.';
  if (agent.ptyBacked || !agent.isExternal) return 'This agent already runs in the office.';
  if (agent.leadAgentId !== undefined || agent.agentName || agent.spawnToolUseId) {
    return 'Teammates and sub-agents run inside their lead and cannot be moved.';
  }
  if (agent.isTeamLead && hasLiveInlineTeammates) {
    // Inline teammates run inside the lead's process: stopping it kills them
    // and the resumed session does not bring them back.
    return 'This lead still has teammates running inside it; wait for them to finish.';
  }
  if (!agent.sessionId) return 'This agent has no session id to resume.';
  if (!hasTranscript) return 'The session transcript is gone; nothing to resume.';
  return null;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when `p` names an existing directory. Shared by the move and restart paths. */
export function dirExists(p: string | undefined): p is string {
  if (!p) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  // Bounded by poll COUNT, not wall clock, so an injected `sleep` makes the
  // wait deterministic in tests (no hot loop against Date.now()).
  const polls = Math.ceil(timeoutMs / MOVE_POLL_INTERVAL_MS);
  for (let i = 0; i < polls; i++) {
    if (!isAlive(pid)) return true;
    await sleep(MOVE_POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}

/** Returns true when the session now runs in-office. */
export async function moveSessionHere(id: number, deps: MoveSessionDeps): Promise<boolean> {
  const { store, runtime, provider, send } = deps;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? defaultSleep;

  const fail = (reason: string): false => {
    console.warn(`[Pixel Agents] Move: Agent ${id} - ${reason}`);
    send({ type: 'moveSessionFailed', id, reason });
    return false;
  };

  const agent = store.get(id);
  const hasTranscript = !!agent?.jsonlFile && fs.existsSync(agent.jsonlFile);
  const refusal = moveRefusalReason(agent, hasTranscript, hasInlineTeammates(id, store));
  if (refusal || !agent) return fail(refusal ?? 'Unknown agent.');
  const ptyHost = runtime.ptyHost;
  if (!ptyHost) return fail('No terminal host (not running standalone?).');
  if (!provider.buildLaunchCommand) return fail(`Provider ${provider.id} cannot launch terminals.`);

  agent.moveInFlight = true;
  try {
    // 2. Locate.
    const live = (await provider.findLiveProcess?.(agent.sessionId)) ?? null;
    const cwd =
      [live?.cwd, provider.transcriptCwd?.(agent.jsonlFile), deps.launchCwd].find(dirExists) ??
      deps.launchCwd;

    // 3. Latch, then 4. stop the outside process. The token ties the grace
    // timer to THIS move: a later move's latch is never cleared by an earlier
    // move's timer, and the timer clears BOTH flags (pendingClear may outlive
    // pendingHandoff when the resumed Claude never sends a SessionStart).
    const token = {};
    agent.moveToken = token;
    agent.pendingHandoff = true;
    agent.pendingClear = true;
    const clearLatch = () => {
      agent.pendingHandoff = false;
      agent.pendingClear = false;
      agent.moveToken = undefined;
    };
    try {
      if (live) {
        kill(live.pid, 'SIGTERM');
        let gone = await waitForExit(live.pid, MOVE_TERMINATE_TIMEOUT_MS, isAlive, sleep);
        if (!gone) {
          kill(live.pid, 'SIGKILL');
          gone = await waitForExit(live.pid, MOVE_KILL_TIMEOUT_MS, isAlive, sleep);
        }
        if (!gone) {
          clearLatch();
          return fail('Could not stop the process in the other terminal.');
        }
      }
    } catch (err) {
      // e.g. EPERM: a proven claude owned by another user. Nothing was spawned.
      clearLatch();
      return fail(`Could not stop the process in the other terminal: ${String(err)}`);
    }
    // If no hook ever arrives (hooks off, resume refused before SessionStart),
    // drop whatever this move left latched.
    setTimeout(() => {
      if (agent.moveToken === token) clearLatch();
    }, MOVE_HANDOFF_GRACE_MS).unref?.();

    // 5. Spawn the resume in a login shell, like launchAgentStandalone.
    const launch = provider.buildLaunchCommand(agent.sessionId, cwd, { resume: true });
    const idx = store.nextTerminalIndex.current++;
    const terminalName = `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`;
    try {
      ptyHost.start(id, {
        shell: process.env.SHELL ?? '/bin/zsh',
        args: ['-l', '-c', [launch.command, ...launch.args].join(' ')],
        cwd,
        env: { ...process.env, ...launch.env },
        cols: 80,
        rows: 24,
        scrollbackCapacity: PTY_SCROLLBACK_MAX_LINES,
      });
    } catch (err) {
      // The outside process is already gone; report it so the user can Restart.
      clearLatch();
      return fail(`The session was stopped but could not be resumed here: ${String(err)}`);
    }

    // 6. Flip.
    agent.isExternal = false;
    agent.ptyBacked = true;
    agent.spawnCwd = cwd;
    agent.terminalRef = { name: terminalName } as vscode.Terminal;
    store.persist();
    store.broadcast({ type: 'sessionMoved', id, terminalName });
    console.log(
      `[Pixel Agents] Move: Agent ${id} - session ${agent.sessionId} resumed in-office (${terminalName}) in ${cwd}`,
    );
    return true;
  } finally {
    agent.moveInFlight = false;
  }
}
