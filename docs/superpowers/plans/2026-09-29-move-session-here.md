# Move Adopted Sessions In-Office — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking an adopted (external) agent in the standalone office stops its Claude process in the outside terminal, resumes the same session in an in-office pty, and turns the agent into an ordinary terminal-backed agent; adopted agents also appear in the rail.

**Architecture:** A privileged `moveSessionHere` client message dispatches to a new `server/src/moveSession.ts` that locates the outside process through a provider seam (`findLiveProcess`, backed by Claude's `~/.claude/sessions/<pid>.json` registry with a start-time + command proof), latches the agent against the outgoing `SessionEnd`, terminates the process, spawns `claude --resume <id>` through the existing pty host, flips the agent to pty-backed, and broadcasts `sessionMoved`. The webview keeps a movable set (top-level, non-teammate, non-pty agents), lists them in the rail with an "outside" marker, and sends the move on canvas or rail click. The Restart button switches to `--resume` when a transcript exists (Claude refuses `--session-id` reuse).

**Tech Stack:** TypeScript, Fastify + AsyncAPI 3.0 (server), React 19 (webview), Vitest, node-pty via the existing `PtyManager`.

**Spec:** `docs/superpowers/specs/2026-09-29-adopted-terminals-and-claimed-seats-design.md` — Part B. Depends on the `renameAgent` protocol commit from `2026-09-29-band-size-and-rename.md` only for CLAUDE.md count arithmetic; otherwise independent.

## Global Constraints

- Standalone adapter only; `adapters/vscode/` untouched.
- Wire messages: every new variant in the right `oneOf` with `additionalProperties: false`; `npm run asyncapi:generate`, commit `core/src/messages.ts`; update CLAUDE.md variant counts to the real union lengths.
- Identifiers never use "attach" or "import" (CONTEXT.md _Avoid_ list); the feature is a **move** (`moveSessionHere`, `sessionMoved`, `moveSessionFailed`, `moveSession.ts`).
- Constants in `server/src/constants.ts`: `MOVE_TERMINATE_TIMEOUT_MS = 5000`, `MOVE_KILL_TIMEOUT_MS = 2000`, `MOVE_POLL_INTERVAL_MS = 100`, `MOVE_HANDOFF_GRACE_MS = 10_000`, `LIVE_PROCESS_START_TOLERANCE_MS = 5000`, `TRANSCRIPT_CWD_TAIL_BYTES = 65_536`.
- A process is signalled ONLY when `findLiveProcess` proved the pid: registry `sessionId` matches, pid alive, `ps` command contains `claude`, and `ps` start time is within `LIVE_PROCESS_START_TOLERANCE_MS` of the registry `procStart`. Any doubt → null → resume without stopping.
- Moves are refused for teammates and sub-agent spawns (`leadAgentId`, `agentName`, or `spawnToolUseId` set) on the server; the webview mirrors the rule for UX.
- Server code uses `.js` extensions on relative imports; webview uses `import type` for types; no `enum`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

- Registry file whose pid was reused by an unrelated process must not be signalled — Task 2 tests command and start-time mismatch → null.
- `SessionEnd(reason=other)` from the outgoing process must not remove the character and must not play the waiting chime — Task 4 tests no `onSessionEnd` call and no `agentStatus: 'waiting'` broadcast.
- Two rapid clicks on the same character must not spawn two ptys — Task 5 tests the in-flight refusal.
- A move on an agent whose transcript was deleted must fail before any signal — Task 5 tests guard order (kill spy never called).
- After a move, a later `restartAgent` must use `--resume` (the transcript exists), or the restart silently dies with "already in use" — Task 3 tests both branches.

---

### Task 1: Protocol — move messages and `teammateAgents`

**Files:**

- Modify: `core/asyncapi.yaml` — ClientMessage `oneOf` (after `RestartAgent`), ServerMessage `oneOf` (after `LaunchAgentFailed`), schemas next to `LaunchAgentFailed`, `ExistingAgents.properties`
- Regenerate: `core/src/messages.ts`
- Modify: `CLAUDE.md` variant counts

**Interfaces:**

- Produces: `{ type: 'moveSessionHere'; id: number }`, `{ type: 'sessionMoved'; id: number; terminalName: string }`, `{ type: 'moveSessionFailed'; id: number; reason: string }`, and `ExistingAgents.teammateAgents?: Record<string, boolean>`.

- [ ] **Step 1: Add the schemas**

Client union, after `- $ref: '#/components/schemas/RestartAgent'`:

```yaml
- $ref: '#/components/schemas/MoveSessionHere'
```

Server union, after `- $ref: '#/components/schemas/LaunchAgentFailed'`:

```yaml
- $ref: '#/components/schemas/SessionMoved'
- $ref: '#/components/schemas/MoveSessionFailed'
```

Schemas, after the `LaunchAgentFailed` block:

```yaml
SessionMoved:
  description: >-
    An adopted agent's session now runs in a server-owned pty: the outside
    process was stopped and the same session resumed in-office. The agent
    is pty-backed from here on. Broadcast.
  type: object
  additionalProperties: false
  required: [type, id, terminalName]
  properties:
    type:
      const: sessionMoved
    id:
      type: integer
    terminalName:
      type: string

MoveSessionFailed:
  description: >-
    A moveSessionHere request was refused or failed; the agent is unchanged.
    Sent point-to-point to the requester.
  type: object
  additionalProperties: false
  required: [type, id, reason]
  properties:
    type:
      const: moveSessionFailed
    id:
      type: integer
    reason:
      type: string
```

Next to the `RestartAgent` schema:

```yaml
MoveSessionHere:
  description: >-
    Move an adopted agent's session into an in-office pty (stop the outside
    process, resume the session here). Privileged only.
  type: object
  additionalProperties: false
  required: [type, id]
  properties:
    type:
      const: moveSessionHere
    id:
      type: integer
```

In `ExistingAgents.properties`, after `terminalNames`:

```yaml
teammateAgents:
  type: object
  description: Map of agent ID (string) to true for agents that are teammates of a lead.
  additionalProperties:
    type: boolean
```

- [ ] **Step 2: Regenerate, validate, count**

Run:

```bash
npm run asyncapi:validate && npm run asyncapi:generate && git diff --stat core/src/messages.ts
awk '/^  schemas:$/{ok=1} ok&&/^    ServerMessage:$/{s=1} ok&&/^    ClientMessage:$/{s=2} /discriminator: type/{s=0} s==1&&/\$ref/{a++} s==2&&/\$ref/{b++} END{print "server="a, "client="b}' core/asyncapi.yaml
```

Expected: validation passes; three new types in `messages.ts`; the awk prints `server=41 client=30` when the rename plan landed first (`server=41 client=29` otherwise) — put the printed counts into CLAUDE.md's two variant bullets and add `moveSessionHere` to the pty-terminals parenthetical.

- [ ] **Step 3: Commit**

```bash
git add core/asyncapi.yaml core/src/messages.ts CLAUDE.md
git commit -m "feat(protocol): moveSessionHere, sessionMoved, moveSessionFailed, teammateAgents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Provider seams — resume flag, `findLiveProcess`, `transcriptCwd`

**Files:**

- Modify: `core/src/provider.ts` (`buildLaunchCommand` opts; new `LiveProcess` type; two optional methods)
- Create: `server/src/providers/hook/claude/liveProcess.ts`
- Modify: `server/src/providers/hook/claude/claude.ts` (`buildLaunchCommand`; add `transcriptCwd`; wire `findLiveProcess`)
- Modify: `server/src/constants.ts` (`LIVE_PROCESS_START_TOLERANCE_MS`, `TRANSCRIPT_CWD_TAIL_BYTES`)
- Test: `server/__tests__/liveProcess.test.ts` (new), `server/__tests__/claude.test.ts` (append)

**Interfaces:**

- Produces (core):

```ts
export interface LiveProcess {
  pid: number;
  cwd?: string;
}
// on HookProvider:
buildLaunchCommand?(sessionId: string, cwd: string, opts?: { bypassPermissions?: boolean; resume?: boolean }): { command: string; args: string[]; env?: Record<string, string> };
findLiveProcess?(sessionId: string): Promise<LiveProcess | null>;
transcriptCwd?(jsonlFile: string): string | undefined;
```

- Produces (claude): `findLiveProcessIn(sessionId, deps: LiveProcessDeps): LiveProcess | null` (pure, sync, injectable) and the default `findLiveProcess(sessionId)`.

- [ ] **Step 1: Write the failing tests**

`server/__tests__/liveProcess.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LIVE_PROCESS_START_TOLERANCE_MS } from '../src/constants.js';
import {
  findLiveProcessIn,
  type LiveProcessDeps,
  parsePsLine,
} from '../src/providers/hook/claude/liveProcess.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// Registry procStart strings are UTC without a zone suffix.
const PROC_START = 'Thu Sep 10 18:06:48 2026';
const PROC_START_MS = Date.parse(`${PROC_START} UTC`);

describe('findLiveProcessIn', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeEntry(pid: number, extra: Record<string, unknown> = {}) {
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: SID, cwd: '/tmp/proj', procStart: PROC_START, ...extra }),
    );
  }

  function deps(over: Partial<LiveProcessDeps> = {}): LiveProcessDeps {
    return {
      registryDir: dir,
      isAlive: () => true,
      inspect: () => ({ startedAtMs: PROC_START_MS, command: 'claude' }),
      ...over,
    };
  }

  it('returns pid and cwd when registry, liveness, command and start time all agree', () => {
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps())).toEqual({ pid: 4242, cwd: '/tmp/proj' });
  });

  it('accepts a start time within the tolerance', () => {
    writeEntry(4242);
    const d = deps({
      inspect: () => ({
        startedAtMs: PROC_START_MS + LIVE_PROCESS_START_TOLERANCE_MS - 1,
        command: '/usr/local/bin/claude --resume x',
      }),
    });
    expect(findLiveProcessIn(SID, d)?.pid).toBe(4242);
  });

  it('returns null when no entry names the session', () => {
    writeEntry(4242, { sessionId: 'other' });
    expect(findLiveProcessIn(SID, deps())).toBeNull();
  });

  it('returns null when the pid is dead', () => {
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps({ isAlive: () => false }))).toBeNull();
  });

  it('returns null when the pid was reused by another command', () => {
    writeEntry(4242);
    const d = deps({ inspect: () => ({ startedAtMs: PROC_START_MS, command: 'node server.js' }) });
    expect(findLiveProcessIn(SID, d)).toBeNull();
  });

  it('returns null when the start time is off by more than the tolerance', () => {
    writeEntry(4242);
    const d = deps({
      inspect: () => ({
        startedAtMs: PROC_START_MS + LIVE_PROCESS_START_TOLERANCE_MS + 1000,
        command: 'claude',
      }),
    });
    expect(findLiveProcessIn(SID, d)).toBeNull();
  });

  it('returns null when ps is unavailable (inspect → null)', () => {
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps({ inspect: () => null }))).toBeNull();
  });

  it('returns null when the entry has no parsable procStart', () => {
    writeEntry(4242, { procStart: 'yesterday-ish' });
    expect(findLiveProcessIn(SID, deps())).toBeNull();
  });

  it('a stale (dead-pid) entry for the same session does not shadow the live one', () => {
    writeEntry(1111); // crashed earlier; file lingered
    writeEntry(4242);
    const d = deps({ isAlive: (pid) => pid === 4242 });
    expect(findLiveProcessIn(SID, d)?.pid).toBe(4242);
  });

  it('ignores unreadable or non-JSON files and a missing registry dir', () => {
    fs.writeFileSync(path.join(dir, '1.json'), '{not json');
    writeEntry(4242);
    expect(findLiveProcessIn(SID, deps())?.pid).toBe(4242);
    expect(findLiveProcessIn(SID, deps({ registryDir: path.join(dir, 'nope') }))).toBeNull();
  });
});

describe('parsePsLine', () => {
  it('parses "lstart command" output into a local-time epoch and the command', () => {
    const out = parsePsLine('Thu Sep 10 14:06:48 2026 claude --session-id abc');
    expect(out).not.toBeNull();
    expect(out!.command).toBe('claude --session-id abc');
    expect(out!.startedAtMs).toBe(Date.parse('Sep 10 2026 14:06:48'));
  });

  it('returns null for empty or malformed output', () => {
    expect(parsePsLine('')).toBeNull();
    expect(parsePsLine('garbage')).toBeNull();
  });
});
```

Append to `server/__tests__/claude.test.ts` (inside the top-level `describe('claudeProvider'`):

```ts
describe('buildLaunchCommand', () => {
  it('uses --session-id by default and --resume when asked', () => {
    const fresh = claudeProvider.buildLaunchCommand!('sid-1', '/tmp/x');
    expect(fresh.command).toBe('claude');
    expect(fresh.args).toEqual(['--session-id', 'sid-1']);
    expect(fresh.env).toEqual({ PWD: '/tmp/x' });
    const resumed = claudeProvider.buildLaunchCommand!('sid-1', '/tmp/x', { resume: true });
    expect(resumed.args).toEqual(['--resume', 'sid-1']);
    const both = claudeProvider.buildLaunchCommand!('sid-1', '/tmp/x', {
      resume: true,
      bypassPermissions: true,
    });
    expect(both.args).toEqual(['--resume', 'sid-1', '--dangerously-skip-permissions']);
  });
});

describe('transcriptCwd', () => {
  it('returns the cwd of the newest record that carries one, tolerating a partial tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cwd-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', cwd: '/old/place' }),
        JSON.stringify({ type: 'assistant', cwd: '/new/place' }),
        JSON.stringify({ type: 'cost-state', totalCostUSD: 1 }),
        '{"type":"assistant","cwd":"/truncated',
      ].join('\n') + '\n',
    );
    expect(claudeProvider.transcriptCwd!(file)).toBe('/new/place');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for a missing file or one with no cwd', () => {
    expect(claudeProvider.transcriptCwd!('/nope/missing.jsonl')).toBeUndefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cwd-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user' }) + '\n');
    expect(claudeProvider.transcriptCwd!(file)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

Add `import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';` to that test file's imports.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/liveProcess.test.ts __tests__/claude.test.ts`
Expected: FAIL — module `liveProcess.js` missing; `resume` ignored; `transcriptCwd` undefined.

- [ ] **Step 3: Core interface**

`core/src/provider.ts`: replace the `buildLaunchCommand?` declaration and add after it:

```ts
  /** Build CLI launch command for +Agent button. `resume` continues an existing
   *  session (Claude: `--resume <id>`) instead of minting one (`--session-id`). */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean; resume?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** The live interactive process (if any) currently running `sessionId`
   *  outside the office, proven well enough to signal. Null on any doubt. */
  findLiveProcess?(sessionId: string): Promise<LiveProcess | null>;
  /** Working directory recorded in a session's transcript, for resuming a
   *  session whose process is gone. Undefined when unknown. */
  transcriptCwd?(jsonlFile: string): string | undefined;
```

and, above `export interface HookProvider`:

```ts
/** A CLI process found running a session outside the office. */
export interface LiveProcess {
  pid: number;
  /** The process's working directory, when the CLI records it. */
  cwd?: string;
}
```

- [ ] **Step 4: Constants**

`server/src/constants.ts`, new section at the end:

```ts
// ── Moving adopted sessions in-office ────────────────────────
/** Max skew between a session registry's recorded process start and `ps`'s
 *  start time for the pid to count as the same process (pid reuse guard). */
export const LIVE_PROCESS_START_TOLERANCE_MS = 5000;
/** Tail window read when looking for a transcript's most recent `cwd`. */
export const TRANSCRIPT_CWD_TAIL_BYTES = 65_536;
/** Wait for SIGTERM to land before escalating. */
export const MOVE_TERMINATE_TIMEOUT_MS = 5000;
/** Wait for SIGKILL to land before giving up. */
export const MOVE_KILL_TIMEOUT_MS = 2000;
/** Liveness poll cadence while waiting for the outside process to exit. */
export const MOVE_POLL_INTERVAL_MS = 100;
/** How long the handoff latch survives with no SessionEnd from the old process. */
export const MOVE_HANDOFF_GRACE_MS = 10_000;
```

- [ ] **Step 5: `liveProcess.ts`**

```ts
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
```

- [ ] **Step 6: `claude.ts` changes**

Replace `buildLaunchCommand`:

```ts
function buildLaunchCommand(
  sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean; resume?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  // Claude refuses `--session-id` for an id that already has a transcript
  // ("Session ID … is already in use"); continuing one is `--resume`.
  const args = opts?.resume ? ['--resume', sessionId] : ['--session-id', sessionId];
  if (opts?.bypassPermissions) args.push('--dangerously-skip-permissions');
  return { command: 'claude', args, env: { PWD: cwd } };
}

/** Newest `cwd` recorded in a transcript's tail (records carry the session's
 *  working directory). Undefined when the file is missing or has none. */
function transcriptCwd(jsonlFile: string): string | undefined {
  let text: string;
  try {
    const stat = fs.statSync(jsonlFile);
    const start = Math.max(0, stat.size - TRANSCRIPT_CWD_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return undefined;
    const fd = fs.openSync(jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const rec = JSON.parse(lines[i]) as { cwd?: unknown };
      if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
    } catch {
      continue; // partial last line or non-JSON
    }
  }
  return undefined;
}
```

Import `TRANSCRIPT_CWD_TAIL_BYTES` from `'../../../constants.js'` and `findLiveProcess` from `'./liveProcess.js'`; add `findLiveProcess,` and `transcriptCwd,` to the exported `claudeProvider` object next to `buildLaunchCommand,`.

- [ ] **Step 7: Run tests, types**

Run: `cd server && npx vitest run __tests__/liveProcess.test.ts __tests__/claude.test.ts && cd .. && npm run check-types`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add core/src/provider.ts server/src/constants.ts server/src/providers/hook/claude/liveProcess.ts server/src/providers/hook/claude/claude.ts server/__tests__/liveProcess.test.ts server/__tests__/claude.test.ts
git commit -m "feat(provider): resume launches, live-process lookup, transcript cwd for Claude

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Restart uses `--resume` when a transcript exists; mock runner learns `--resume`

**Files:**

- Modify: `server/src/clientMessageHandler.ts` (`case 'restartAgent'`)
- Modify: `e2e/fixtures/mock-claude-runner.cjs` (`parseSessionId`)
- Test: `server/__tests__/clientMessageHandler.pty.test.ts` (`describe('restartAgent'`), `server/__tests__/mockClaudeRunner.test.ts`

- [ ] **Step 1: Failing tests**

In `describe('restartAgent'`, add:

```ts
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
```

In `mockClaudeRunner.test.ts`, `runMockClaude(...)` hardcodes `'--session-id'` in its `spawn` argv — add a trailing `flag: '--session-id' | '--resume' = '--session-id'` parameter and use it. Then add a test next to the existing spawn test that calls `runMockClaude(…, '--resume')` and asserts the same invocation log line / transcript path as the `--session-id` case (copy that test's assertions verbatim).

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.pty.test.ts -t "resume" && npx vitest run __tests__/mockClaudeRunner.test.ts`
Expected: FAIL — restart args still `--session-id`; runner logs `session-id=`.

- [ ] **Step 3: Implement**

`clientMessageHandler.ts` restart case: replace the `buildLaunchCommand` call with

```ts
const launch = ctx.provider.buildLaunchCommand(agent.sessionId, cwd, {
  bypassPermissions: agent.bypassPermissions,
  // Claude refuses --session-id for an id that already has a transcript.
  resume: fs.existsSync(agent.jsonlFile),
});
```

`clientMessageHandler.ts` imports only `os` today — add `import * as fs from 'fs';` next to it.

`mock-claude-runner.cjs`:

```js
function parseSessionId(argv) {
  let previous = '';
  for (const arg of argv) {
    if (previous === '--session-id' || previous === '--resume') {
      return arg;
    }
    previous = arg;
  }
  return '';
}
```

- [ ] **Step 4: Run, commit**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.pty.test.ts __tests__/mockClaudeRunner.test.ts`
Expected: PASS.

```bash
git add server/src/clientMessageHandler.ts e2e/fixtures/mock-claude-runner.cjs server/__tests__/clientMessageHandler.pty.test.ts server/__tests__/mockClaudeRunner.test.ts
git commit -m "fix(server): restart resumes an existing session instead of reusing its id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Handoff latch in the hook handler

**Files:**

- Modify: `server/src/types.ts` (`AgentState`: `pendingHandoff?: boolean; moveInFlight?: boolean;` next to `pendingClear`)
- Modify: `server/src/hookEventHandler.ts` (`handleSessionEnd`, `markAgentWaiting` split, known-agent SessionStart path)
- Test: `server/__tests__/hookEventHandler.test.ts`

**Interfaces:**

- Produces: `AgentState.pendingHandoff`, `AgentState.moveInFlight`; private `clearTurnTools(agent, agentId)` = everything `markAgentWaiting` does before it sets `isWaiting`/broadcasts the status.

- [ ] **Step 1: Failing tests**

Add to `hookEventHandler.test.ts`, INSIDE the outer `describe('HookEventHandler'` block (it closes over `agents`, `handler`, `mockWebview`; `handler.setLifecycleCallbacks` exists):

```ts
describe('SessionEnd during a move (pendingHandoff)', () => {
  it('does not end the session, clears the latch, clears tools, and sends no waiting status', () => {
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1', pendingHandoff: true });
    agent.activeToolIds.add('t1');
    agent.activeToolStatuses.set('t1', 'Reading x');
    agent.activeToolNames.set('t1', 'Read');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'other',
    });

    expect(onSessionEnd).not.toHaveBeenCalled();
    expect(agent.pendingHandoff).toBe(false);
    expect(agent.activeToolIds.size).toBe(0);
    expect(mockWebview.messages.find((m) => m.type === 'agentToolsClear')).toBeTruthy();
    expect(
      mockWebview.messages.find((m) => m.type === 'agentStatus' && m.status === 'waiting'),
    ).toBeUndefined();
  });

  it('without the latch, SessionEnd(other) still ends the session', () => {
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });
    agents.set(1, createTestAgent({ id: 1, sessionId: 'sess-1' }));
    handler.registerAgent('sess-1', 1);
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'other',
    });
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'other');
  });

  it('an auto-discovered SessionStart(resume) clears pendingClear too', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1', pendingClear: true });
    agents.set(1, agent); // NOT registered with the router
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'resume',
      cwd: '/test',
    });
    expect(agent.pendingClear).toBe(false);
  });

  it('a known-agent SessionStart(resume) clears pendingClear', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1', pendingClear: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'resume',
      cwd: '/test',
    });
    expect(agent.pendingClear).toBe(false);
    expect(agent.hookDelivered).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/hookEventHandler.test.ts -t "pendingHandoff|pendingClear"`
Expected: FAIL — `onSessionEnd` called; `pendingClear` still true.

- [ ] **Step 3: Implement**

`types.ts`, after `pendingClear?: boolean;`:

```ts
  /** Set while an adopted session is being moved in-office: the outgoing
   *  process's SessionEnd must not remove the agent. Runtime-only. */
  pendingHandoff?: boolean;
  /** A moveSessionHere is in progress for this agent. Runtime-only. */
  moveInFlight?: boolean;
  /** Identity of the move that armed the current latch (its grace timer only
   *  clears its own latch). Runtime-only. */
  moveToken?: object;
```

`hookEventHandler.ts`:

1. Split `markAgentWaiting`: everything EXCEPT `agent.isWaiting = true` and the `agentStatus` broadcast moves into a new `private clearTurnTools(agent: AgentState, agentId: number): void` — timer cancels, the foreground tool sweep, the `agentToolsClear` broadcast, the background re-send loop, AND the three resets `permissionSent = false`, `hadToolsInTurn = false`, `currentHookToolId = undefined` (a handoff must not carry the killed process's hook-tool correlation into the resumed session). `markAgentWaiting` becomes `this.clearTurnTools(agent, agentId); agent.isWaiting = true; this.agents.broadcast({ type: 'agentStatus', … })`. Its behaviour is unchanged.

2. At the top of `handleSessionEnd`, before `expectsFollowUp`:

```ts
// A move in progress: this SessionEnd is the OUTSIDE process going away,
// not the session ending. Drop tool state (no waiting chime) and keep the
// agent; the in-office resume re-announces itself with SessionStart.
if (agent.pendingHandoff) {
  agent.pendingHandoff = false;
  this.clearTurnTools(agent, agentId);
  if (debug) console.log(`[Pixel Agents] Hook: Agent ${agentId} - SessionEnd during move, kept`);
  return;
}
```

3. In the SessionStart known-agent branch (`if (existingAgentId !== undefined)`), inside `if (agent)`, add `agent.pendingClear = false;` after `agent.hookDelivered = true;` with the comment `// Same-id resume (a move): no reassign will follow.` Do the same in the auto-discovery branch just below it (`if (agent.sessionId === event.session_id)`), after its `agent.hookDelivered = true;` — a moved agent whose hooks were never registered takes that path.

- [ ] **Step 4: Run all handler tests, commit**

Run: `cd server && npx vitest run __tests__/hookEventHandler.test.ts`
Expected: PASS (whole file).

```bash
git add server/src/types.ts server/src/hookEventHandler.ts server/__tests__/hookEventHandler.test.ts
git commit -m "feat(server): handoff latch keeps an agent through its outside process's SessionEnd

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `moveSession.ts`

**Files:**

- Create: `server/src/moveSession.ts`
- Test: `server/__tests__/moveSession.test.ts`

**Interfaces:**

- Consumes: Task 2 provider seams; Task 4 flags; `PtyManager.start`; `AgentRuntime` (`ptyHost`, `store.nextTerminalIndex`); `CLAUDE_TERMINAL_NAME_PREFIX`; `PTY_SCROLLBACK_MAX_LINES`.
- Produces:

```ts
export interface MoveSessionDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  provider: HookProvider;
  launchCwd: string;
  send: (m: Record<string, unknown>) => void;
  /** Test seams. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}
export function moveRefusalReason(
  agent: AgentState | undefined,
  hasTranscript: boolean,
): string | null;
export async function moveSessionHere(id: number, deps: MoveSessionDeps): Promise<boolean>;
```

- [ ] **Step 1: Failing tests**

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { MOVE_HANDOFF_GRACE_MS } from '../src/constants.js';
import { moveRefusalReason, moveSessionHere, type MoveSessionDeps } from '../src/moveSession.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager, PtyStartOptions } from '../src/pty/ptyManager.js';
import type { AgentState } from '../src/types.js';
import type { HookProvider, LiveProcess } from '../../core/src/provider.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 4,
    sessionId: 'sess-4',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/sess-4.jsonl',
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
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function makeFakePtyHost() {
  const starts: Array<{ id: number; opts: PtyStartOptions }> = [];
  const host = {
    start: vi.fn((id: number, opts: PtyStartOptions) => starts.push({ id, opts })),
    stop: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn(() => true),
    exitInfo: vi.fn(() => undefined),
    crashedAgentIds: vi.fn(() => []),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, starts };
}

describe('moveSessionHere', () => {
  let tmp: string;
  let transcript: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;
  let starts: Array<{ id: number; opts: PtyStartOptions }>;
  let kill: ReturnType<typeof vi.fn>;
  let alive: boolean;

  function provider(live: LiveProcess | null): HookProvider {
    return {
      ...claudeProvider,
      findLiveProcess: vi.fn(async () => live),
      transcriptCwd: () => undefined,
    };
  }

  function deps(live: LiveProcess | null, over: Partial<MoveSessionDeps> = {}): MoveSessionDeps {
    return {
      store,
      runtime,
      provider: provider(live),
      launchCwd: tmp,
      send: (m) => sent.push(m),
      kill: kill as unknown as MoveSessionDeps['kill'],
      isAlive: () => alive,
      sleep: async () => {
        alive = false; // the process "exits" on the first wait
      },
      ...over,
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-move-'));
    transcript = path.join(tmp, 'sess-4.jsonl');
    fs.writeFileSync(transcript, '{"type":"user","cwd":"/nope"}\n');
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const fake = makeFakePtyHost();
    runtime.setPtyHost(fake.host);
    starts = fake.starts;
    sent = [];
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    kill = vi.fn();
    alive = true;
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stops the outside process, resumes in a pty in its cwd, flips the agent, broadcasts sessionMoved', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript }));
    const ok = await moveSessionHere(4, deps({ pid: 777, cwd: tmp }));
    expect(ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(starts).toHaveLength(1);
    expect(starts[0].id).toBe(4);
    expect(starts[0].opts.cwd).toBe(tmp);
    expect(starts[0].opts.args.at(-1)).toContain('claude --resume sess-4');
    const agent = store.get(4)!;
    expect(agent.isExternal).toBe(false);
    expect(agent.ptyBacked).toBe(true);
    expect(agent.spawnCwd).toBe(tmp);
    expect(agent.terminalRef?.name).toMatch(/^Claude Code #\d+$/);
    expect(agent.moveInFlight).toBeFalsy();
    expect(broadcasts.at(-1)).toEqual({
      type: 'sessionMoved',
      id: 4,
      terminalName: agent.terminalRef!.name,
    });
    expect(sent).toHaveLength(0);
  });

  it('sets the handoff latch and pendingClear BEFORE signalling', async () => {
    const agent = createTestAgent({ jsonlFile: transcript });
    store.set(4, agent);
    let latchedAtKill = false;
    kill.mockImplementation(() => {
      latchedAtKill = agent.pendingHandoff === true && agent.pendingClear === true;
    });
    await moveSessionHere(4, deps({ pid: 777, cwd: tmp }));
    expect(latchedAtKill).toBe(true);
  });

  it('with no live process, resumes without signalling, in the transcript cwd, then launchCwd', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript }));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-move-cwd-'));
    const d = deps(null);
    d.provider = { ...d.provider, transcriptCwd: () => other };
    await moveSessionHere(4, d);
    expect(kill).not.toHaveBeenCalled();
    expect(starts[0].opts.cwd).toBe(other);
    fs.rmSync(other, { recursive: true, force: true });

    store.set(5, createTestAgent({ id: 5, sessionId: 'sess-5', jsonlFile: transcript }));
    const d2 = deps(null);
    d2.provider = { ...d2.provider, transcriptCwd: () => '/does/not/exist' };
    await moveSessionHere(5, d2);
    expect(starts[1].opts.cwd).toBe(tmp);
  });

  it('escalates to SIGKILL and fails when the process will not die; agent untouched', async () => {
    const agent = createTestAgent({ jsonlFile: transcript });
    store.set(4, agent);
    const d = deps({ pid: 777, cwd: tmp }, { sleep: async () => {} }); // never exits; bounded by poll count
    const ok = await moveSessionHere(4, d);
    expect(ok).toBe(false);
    expect(kill).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(777, 'SIGKILL');
    expect(starts).toHaveLength(0);
    expect(agent.isExternal).toBe(true);
    expect(agent.ptyBacked).toBeFalsy();
    expect(agent.pendingHandoff).toBe(false);
    expect(agent.pendingClear).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });

  it('a throwing kill (EPERM) fails cleanly with the latch cleared and nothing spawned', async () => {
    const agent = createTestAgent({ jsonlFile: transcript });
    store.set(4, agent);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(await moveSessionHere(4, deps({ pid: 777, cwd: tmp }))).toBe(false);
    expect(starts).toHaveLength(0);
    expect(agent.pendingHandoff).toBe(false);
    expect(agent.pendingClear).toBe(false);
    expect(agent.moveInFlight).toBeFalsy();
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });

  it('the grace timer clears both latch flags when no hook ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const agent = createTestAgent({ jsonlFile: transcript });
      store.set(4, agent);
      await moveSessionHere(4, deps(null));
      expect(agent.pendingHandoff).toBe(true);
      expect(agent.pendingClear).toBe(true);
      vi.advanceTimersByTime(MOVE_HANDOFF_GRACE_MS + 1);
      expect(agent.pendingHandoff).toBe(false);
      expect(agent.pendingClear).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a second move while one is in flight', async () => {
    store.set(4, createTestAgent({ jsonlFile: transcript }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps(
      { pid: 777, cwd: tmp },
      {
        sleep: async () => {
          await gate;
          alive = false;
        },
      },
    );
    const first = moveSessionHere(4, d);
    const second = await moveSessionHere(4, d);
    expect(second).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
    release();
    expect(await first).toBe(true);
    expect(starts).toHaveLength(1);
  });

  it('refuses before signalling when the transcript is missing', async () => {
    store.set(4, createTestAgent({ jsonlFile: path.join(tmp, 'gone.jsonl') }));
    expect(await moveSessionHere(4, deps({ pid: 777 }))).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'moveSessionFailed', id: 4 });
  });
});

describe('moveRefusalReason', () => {
  const base = (over: Partial<AgentState>) => createTestAgent({ jsonlFile: '/x', ...over });
  it('accepts a plain external agent with a transcript', () => {
    expect(moveRefusalReason(base({}), true)).toBeNull();
  });
  it('refuses unknown, non-external, pty-backed, sessionless, transcript-less, in-flight', () => {
    expect(moveRefusalReason(undefined, true)).toBeTruthy();
    expect(moveRefusalReason(base({ isExternal: false }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ ptyBacked: true }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ sessionId: '' }), true)).toBeTruthy();
    expect(moveRefusalReason(base({}), false)).toBeTruthy();
    expect(moveRefusalReason(base({ moveInFlight: true }), true)).toBeTruthy();
  });
  it('refuses teammates and sub-agent spawns', () => {
    expect(moveRefusalReason(base({ leadAgentId: 1 }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ agentName: 'researcher' }), true)).toBeTruthy();
    expect(moveRefusalReason(base({ spawnToolUseId: 'toolu_1' }), true)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/moveSession.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `server/src/moveSession.ts`**

```ts
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
): string | null {
  if (!agent) return 'Unknown agent.';
  if (agent.moveInFlight) return 'A move is already in progress.';
  if (agent.ptyBacked || !agent.isExternal) return 'This agent already runs in the office.';
  if (agent.leadAgentId !== undefined || agent.agentName || agent.spawnToolUseId) {
    return 'Teammates and sub-agents run inside their lead and cannot be moved.';
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

function dirExists(p: string | undefined): p is string {
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
  const refusal = moveRefusalReason(agent, hasTranscript);
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
```

Check `store.nextTerminalIndex` exists (it does: `launchAgentStandalone.ts` uses `store.nextTerminalIndex.current++`). If `AgentRuntime.ptyHost` is a getter returning `PtyManager | null`, the `!ptyHost` guard is correct.

- [ ] **Step 4: Run tests, types**

Run: `cd server && npx vitest run __tests__/moveSession.test.ts && cd .. && npm run check-types`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/moveSession.ts server/__tests__/moveSession.test.ts
git commit -m "feat(server): moveSessionHere stops the outside process and resumes in a pty

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Dispatch `moveSessionHere` and report `teammateAgents`

**Files:**

- Modify: `server/src/clientMessageHandler.ts` (new case after `restartAgent`; `existingAgents` payload)
- Test: `server/__tests__/clientMessageHandler.pty.test.ts`

- [ ] **Step 1: Failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.pty.test.ts -t "moveSessionHere|teammateAgents"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`clientMessageHandler.ts`: import `moveSessionHere` from `'./moveSession.js'`; after the `restartAgent` case:

```ts
    case 'moveSessionHere': {
      if (!ctx.privileged || !runtime || !ctx.provider || !ctx.launchCwd) break;
      // Fire-and-forget: the outcome reaches the client as sessionMoved
      // (broadcast) or moveSessionFailed (point-to-point).
      void moveSessionHere(msg.id as number, {
        store,
        runtime,
        provider: ctx.provider,
        launchCwd: ctx.launchCwd,
        send,
      });
      break;
    }
```

In the `existingAgents` builder (`handleWebviewReady`), add `const teammateAgents: Record<number, boolean> = {};`, fill it in the loop with `if (agent.leadAgentId !== undefined) teammateAgents[id] = true;`, and add `teammateAgents,` to `existingAgentsMsg`.

- [ ] **Step 4: Run, commit**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.pty.test.ts __tests__/clientMessageHandler.test.ts`
Expected: PASS.

```bash
git add server/src/clientMessageHandler.ts server/__tests__/clientMessageHandler.pty.test.ts
git commit -m "feat(server): dispatch moveSessionHere; existingAgents carries teammateAgents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Webview — movable set, rail entries, placeholder pane, click-to-move

**Files:**

- Modify: `webview-ui/src/hooks/useExtensionMessages.ts` (state + message branches + return)
- Modify: `webview-ui/src/components/terminal/AgentRail.tsx` (`RailAgent` fields, marker)
- Modify: `webview-ui/src/components/terminal/TerminalBand.tsx` (placeholder pane)
- Modify: `webview-ui/src/App.tsx` (`railAgents`, prune, click, selection, move request)

**Interfaces:**

- Consumes: Task 1 messages; `hasPrivilegedToken`, `isBrowserRuntime` from `./runtime.js`.
- Produces from the hook: `teammateIds: Record<number, boolean>`, `movePending: Record<number, boolean>`, `moveErrors: Record<number, string>`, `markMovePending(id: number): void`.
- `RailAgent` becomes `{ id: number; label: string; attached: boolean; moveState: 'idle' | 'pending' | 'error'; moveError?: string }`.

- [ ] **Step 1: Hook state and message handling**

In `useExtensionMessages.ts`, next to `ptyBackedByAgent`:

```ts
/** Agents that are teammates of a lead (from agentCreated.isTeammate,
 *  existingAgents.teammateAgents, or agentTeamInfo with a leadAgentId).
 *  Teammates never get a rail entry and are never movable. */
const [teammateIds, setTeammateIds] = useState<Record<number, boolean>>({});
/** moveSessionHere requests in flight, keyed by agent id. */
const [movePending, setMovePending] = useState<Record<number, boolean>>({});
/** Last moveSessionFailed reason per agent, until the next attempt. */
const [moveErrors, setMoveErrors] = useState<Record<number, string>>({});
```

Helper (module scope):

```ts
function without<T>(map: Record<number, T>, id: number): Record<number, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}
```

Message branches:

- `agentCreated`: after `const isTeammate = …`, add `if (isTeammate) setTeammateIds((prev) => ({ ...prev, [id]: true }));`
- `existingAgents`: read `const teammateAgents = (msg.teammateAgents || {}) as Record<number, boolean>;` and `if (Object.keys(teammateAgents).length > 0) setTeammateIds((prev) => ({ ...prev, ...teammateAgents }));`
- `agentTeamInfo`: after `os.setTeamInfo(...)`, add `if (msg.leadAgentId !== undefined) setTeammateIds((prev) => ({ ...prev, [id]: true }));`
- `agentClosed`: add `setTeammateIds((prev) => without(prev, id)); setMovePending((prev) => without(prev, id)); setMoveErrors((prev) => without(prev, id));`
- New branches next to `agentRenamed`:

```ts
      } else if (msg.type === 'sessionMoved') {
        const id = msg.id as number;
        setPtyBackedByAgent((prev) => ({ ...prev, [id]: true }));
        if (typeof msg.terminalName === 'string' && msg.terminalName) {
          const terminalName = msg.terminalName as string;
          setTerminalNames((prev) => ({ ...prev, [id]: terminalName }));
        }
        setMovePending((prev) => without(prev, id));
        setMoveErrors((prev) => without(prev, id));
      } else if (msg.type === 'moveSessionFailed') {
        const id = msg.id as number;
        const reason = String(msg.reason ?? 'Move failed.');
        setMovePending((prev) => without(prev, id));
        setMoveErrors((prev) => ({ ...prev, [id]: reason }));
      }
```

Return: add `teammateIds, movePending, moveErrors,` and

```ts
    markMovePending: useCallback((id: number) => {
      setMovePending((prev) => ({ ...prev, [id]: true }));
      setMoveErrors((prev) => without(prev, id));
    }, []),
```

- [ ] **Step 2: Rail entries**

`AgentRail.tsx`: extend the interface and render a marker for unattached entries (inside the entry, before the label span):

```ts
export interface RailAgent {
  id: number;
  label: string;
  /** False for an adopted session still running outside the office. */
  attached: boolean;
  moveState: 'idle' | 'pending' | 'error';
  moveError?: string;
}
```

Inside each entry, before the label span, render an "outside" marker for unattached entries, and mute the whole entry (spec: non-pty entries render muted) by adding `opacity-60` to the entry's `className` when `!agent.attached`:

```text
{!agent.attached && (
  <span
    className="text-2xs text-text-muted"
    title={
      agent.moveState === 'pending'
        ? 'Moving this session here…'
        : (agent.moveError ?? 'Running outside the office — click to move it here')
    }
    aria-label="outside"
  >
    {agent.moveState === 'pending' ? '⋯' : '⇠'}
  </span>
)}
```

- [ ] **Step 3: Placeholder pane**

`TerminalBand.tsx`, replace the `{focused ? <TerminalPane…/> : …}` block:

```tsx
      {focused ? (
        focused.attached ? (
          <TerminalPane
            agentId={focused.id}
            agentName={focused.label}
            bus={bus}
            onRestartAgent={onRestartAgent}
          />
        ) : (
          <div
            className={`flex-1 flex items-center justify-center text-2xs px-8 text-center ${
              focused.moveState === 'error' ? 'text-danger' : 'text-text-muted'
            } ${focused.moveState === 'idle' ? 'cursor-pointer' : ''}`}
            onClick={focused.moveState === 'idle' ? () => onFocus(focused.id) : undefined}
            role={focused.moveState === 'idle' ? 'button' : undefined}
            data-testid="move-session-placeholder"
          >
            {focused.moveState === 'pending'
              ? 'Moving this session here…'
              : focused.moveState === 'error'
                ? `${focused.moveError ?? 'Move failed.'} Click to try again.`
                : 'This session runs in another terminal. Click to move it into the office.'}
          </div>
        )
      ) : (
```

For the error state, make the div clickable too (`onClick` when `moveState !== 'pending'`), so "Click to try again" works; adjust the two conditionals accordingly.

- [ ] **Step 4: App wiring**

`App.tsx`:

1. Destructure `teammateIds, movePending, moveErrors, markMovePending` from the hook.
2. `railAgents` becomes:

```ts
const railAgents = useMemo(
  () =>
    agents
      .filter((id) => !teammateIds[id] && !getOfficeState().subagentMeta.has(id))
      .map((id) => ({
        id,
        label: characterLabel({
          customTitle: customTitles[id],
          agentName: getOfficeState().characters.get(id)?.agentName,
          terminalName: terminalNames[id],
          id,
        }),
        attached: ptyBackedByAgent[id] === true,
        moveState: (movePending[id]
          ? 'pending'
          : moveErrors[id]
            ? 'error'
            : 'idle') as RailAgent['moveState'],
        moveError: moveErrors[id],
      })),
  [agents, teammateIds, ptyBackedByAgent, customTitles, terminalNames, movePending, moveErrors],
);
```

(`import type { RailAgent } from './components/terminal/AgentRail.js';`.) `agents` holds top-level ids only in practice; the `subagentMeta` filter is belt-and-braces.

3. Prune effect: replace the `!ptyBackedByAgent[focusedTerminalId]` condition with `!railAgents.some((a) => a.id === focusedTerminalId)` and update the dependency array to `[focusedTerminalId, railAgents]`.

4. Move request helper, next to `handleCloseAgent`:

```ts
const isMovable = useCallback(
  (id: number) =>
    isBrowserRuntime && hasPrivilegedToken && !ptyBackedByAgent[id] && !teammateIds[id],
  [ptyBackedByAgent, teammateIds],
);

const requestMove = useCallback(
  (id: number) => {
    if (!isMovable(id) || movePending[id]) return;
    markMovePending(id);
    transport.send({ type: 'moveSessionHere', id });
  },
  [isMovable, movePending, markMovePending],
);
```

5. `handleClick` (canvas): after `transport.send({ type: 'focusAgent', id: focusId });` replace the `if (ptyBackedByAgent[focusId]) setFocusedTerminalId(focusId)` block with:

```ts
if (ptyBackedByAgent[focusId]) {
  setFocusedTerminalId(focusId);
} else if (isMovable(focusId)) {
  setFocusedTerminalId(focusId);
  setTerminalOpen(true);
  requestMove(focusId);
}
```

and add `isMovable, requestMove, setTerminalOpen` to its dependency array.

6. `handleSelectionChange`: `if (ptyBackedByAgent[resolved] || isMovable(resolved)) { setFocusedTerminalId(resolved); setTerminalOpen(true); }` with `isMovable` in the deps.

7. Rail focus: `onFocus={(id) => { setFocusedTerminalId(id); requestMove(id); }}` (`requestMove` is a no-op for attached agents).

8. The band's render gate `railAgents.length > 0` stays; unattached agents now count, which is intended.

9. The auto-open-on-spawn effect (`pendingSpawnOpenRef`, `prevRailIdsRef`): `fresh` must only consider ATTACHED entries — `railAgents.filter((a) => a.attached && !prev.has(a.id))` — or a scanner adoption landing during a pending spawn steals the auto-open onto a placeholder.

- [ ] **Step 5: Types, lint, build, manual check**

Run: `npm run check-types && npm run lint && npm run build:webview`
Expected: clean.

Manual, with the daemon restarted on the new build and Watch All Sessions on: an adopted character appears in the rail with the ⇠ marker; clicking it opens the band with the placeholder, the Claude in the VS Code terminal exits within a couple of seconds, and the pane fills with the resumed session; the character keeps its seat; typing works. Clicking a teammate character does nothing new. With the transcript deleted (test by renaming one), the pane shows the refusal text.

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/hooks/useExtensionMessages.ts webview-ui/src/components/terminal/AgentRail.tsx webview-ui/src/components/terminal/TerminalBand.tsx webview-ui/src/App.tsx
git commit -m "feat(webview): adopted agents in the rail; click moves the session in-office

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Verification

- [ ] **Step 1: Everything CI runs, minus e2e**

Run: `npm run lint && npm run asyncapi:validate && npm run asyncapi:generate && git diff --exit-code core/src/messages.ts && npm run check-types && npm test`
Expected: clean.

- [ ] **Step 2: Standalone e2e, including the restart scenario**

Run: `npm run e2e -- --workers=1 --grep "standalone"`
Expected: PASS; in particular "pty crash marks the character and restart clears it" passes with the mock runner now accepting `--resume`.

- [ ] **Step 3: CLAUDE.md**

Add one line under "Key Decisions": "**Moving an adopted session in-office** stops the outside process only when Claude's own session registry proves the pid (command + start time); otherwise the session is resumed without a kill. The handoff latch (`pendingHandoff`) keeps the agent through the outgoing `SessionEnd`; `--resume`, never `--session-id`, continues an existing transcript (Claude refuses reuse)." Commit with `docs:`.
