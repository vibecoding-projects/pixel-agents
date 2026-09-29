/**
 * Claude Code writes `~/.claude/sessions/<pid>.json` for every interactive
 * session ({ pid, sessionId, cwd, procStart, ... }) and removes it on a clean
 * exit. The file LINGERS after a crash or SIGKILL and pids get reused, so an
 * entry is only trusted when `ps` shows a claude command whose start time
 * matches the entry's `procStart`. Every doubt returns null: the caller then
 * resumes the session without signalling anything.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { LiveProcess } from '../../../../../core/src/provider.js';
import { LIVE_PROCESS_START_TOLERANCE_MS } from '../../../constants.js';

export interface LiveProcessDeps {
  registryDir: string;
  isAlive: (pid: number) => boolean;
  /** `ps` view of a pid, or null when ps is unavailable or the pid is gone. */
  inspect: (pid: number) => { startedAtMs: number; command: string } | null;
}

interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  procStart?: string;
}

/** Parse one line of `ps -o lstart=,command= -p <pid>`:
 *  "Thu Sep 10 14:06:48 2026 claude --session-id x" (local time). */
export function parsePsLine(line: string): { startedAtMs: number; command: string } | null {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.*)$/.exec(line);
  if (!m) return null;
  const startedAtMs = Date.parse(`${m[1]} ${m[2]} ${m[4]} ${m[3]}`);
  if (!Number.isFinite(startedAtMs)) return null;
  return { startedAtMs, command: m[5].trim() };
}

function readEntries(dir: string): RegistryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, name), 'utf8'),
      ) as Partial<RegistryEntry>;
      if (typeof raw.pid === 'number' && typeof raw.sessionId === 'string') {
        out.push(raw as RegistryEntry);
      }
    } catch {
      /* unreadable or not JSON — skip */
    }
  }
  return out;
}

/** Pure core: registry lookup + proof. Exported for tests. */
export function findLiveProcessIn(sessionId: string, deps: LiveProcessDeps): LiveProcess | null {
  for (const entry of readEntries(deps.registryDir)) {
    if (entry.sessionId !== sessionId) continue;
    // A registry file lingers after a crash/SIGKILL, so a stale entry for the
    // same session can sit beside the live one: every failed proof is
    // `continue`, never a verdict — only a PROVEN entry is returned.
    if (!deps.isAlive(entry.pid)) continue;
    // Registry procStart is UTC without a zone suffix; ps lstart is local time.
    const recorded = entry.procStart ? Date.parse(`${entry.procStart} UTC`) : NaN;
    if (!Number.isFinite(recorded)) continue;
    const seen = deps.inspect(entry.pid);
    if (!seen) continue;
    if (!/\bclaude\b/.test(seen.command)) continue;
    if (Math.abs(seen.startedAtMs - recorded) > LIVE_PROCESS_START_TOLERANCE_MS) continue;
    return { pid: entry.pid, cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined };
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but not ours — alive, though we could not signal it anyway.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function inspect(pid: number): { startedAtMs: number; command: string } | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' }, // English month names for the parser
    });
    return parsePsLine(out.split('\n').find((l) => l.trim()) ?? '');
  } catch {
    return null; // no ps (Windows), or the pid is gone
  }
}

/** Default lookup against the real registry and the real `ps`. */
export async function findLiveProcess(sessionId: string): Promise<LiveProcess | null> {
  return findLiveProcessIn(sessionId, {
    registryDir: path.join(os.homedir(), '.claude', 'sessions'),
    isAlive,
    inspect,
  });
}
