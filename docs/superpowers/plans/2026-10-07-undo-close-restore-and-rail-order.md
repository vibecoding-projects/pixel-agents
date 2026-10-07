# Undo Close, Closed-Session Restore, Rail Reordering, Tab Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closing an agent in the standalone office becomes undoable for 10 s (live process kept), closed in-office sessions land on a restorable "Closed" list at the bottom of the rail, the rail order is draggable and persisted, and the browser tab gets a Pixel Agents favicon + title.

**Architecture:** The server owns the grace window: `closeAgent` snapshots seat/rail-index/kind onto `AgentState.closing`, arms a timer on `AgentRuntime`, and only `finalizeClose` kills the pty and appends a `ClosedSession` record (persisted in `standalone-state.json`). Undo and restore both go out as one `agentCreated` built by a single shared builder, followed by a per-agent activity resend. Rail order is a server-persisted id list (`AgentStateStore.agentOrder`). The webview tears the character down on `agentClosing`, filters every per-agent message for closing ids, shows an App-level Undo toast, and renders the Closed section + drag reorder in `AgentRail`.

**Tech Stack:** TypeScript (Node16 modules, `.js` import suffixes in server/core), Fastify + WebSocket, React 19, Vitest (server + webview Node runner), Playwright (standalone fixture), AsyncAPI 3.0 → Modelina codegen.

**Spec:** `docs/superpowers/specs/2026-10-07-undo-close-restore-and-rail-order-design.md`

## Global Constraints

- Strict layering: `core/` imports nothing from `server/` or `webview-ui/`; `server/` imports `core/` only; `webview-ui/` imports `core/` only.
- `core/src/messages.ts` is GENERATED. Edit `core/asyncapi.yaml`, run `npm run asyncapi:generate`, commit both. CI fails on drift.
- `server/` and `core/` relative imports carry `.js` suffixes. Webview uses `import type` for type-only imports (`verbatimModuleSyntax`), no `enum`, `noUnusedLocals`/`noUnusedParameters` everywhere.
- Constants live in `server/src/constants.ts` (server) / `webview-ui/src/constants.ts` (webview). No magic numbers inline.
- Webview styling: hex/rgb literals only in `webview-ui/src/constants.ts`; shadows via the Tailwind `shadow-pixel` class (an inline `boxShadow` string literal only passes the `pixel-shadow` lint rule as `2px 2px 0px …`; the CSS token is `--shadow-pixel`, so `var(--shadow-pixel)` inline can never pass); borders `2px solid`; `borderRadius: 0`; FS Pixel Sans is global. ESLint rules `no-inline-colors`, `pixel-shadow`, `pixel-font` block PRs.
- Logging prefix `[Pixel Agents]` on the server, `[Webview]` in the SPA.
- Commit after every task with the attribution trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. The pre-commit hook runs prettier on staged files; stage again if it rewrites.
- Run from the repo root: `npm run test:server`, `npm run test:webview`, `npm run check-types`, `npm run lint`, `npm run e2e -- --grep "<name>"`.
- `CLOSE_GRACE_MS = 10_000`, `CLOSED_SESSIONS_MAX = 10` (server constants). `graceMs` travels on the wire; no webview copy.
- Standalone only. `adapters/vscode/` is not touched.

## Review Focus

Inputs the spec implies but which are easy to break, each pinned by a test in the owning task:

1. A seat save that arrives inside the window must not change what undo/finalize read (Task 7 test "seat snapshot survives a saveAgentSeats inside the window").
2. A second `closeAgent` for an already-closing id, and `undoClose` for a non-closing id, are no-ops that emit nothing (Task 7).
3. A removal through another path inside the window (external sessionEnd) cancels the timer and finalize never writes a record (Task 6).
4. Restore when the session is already live again (adopted from outside) drops the record and spawns nothing (Task 9).
5. A `reorderAgents` carrying stale/unknown ids and missing current ones is repaired, never trusted (Task 4).

---

### Task 1: Protocol, core types, adapter interface, constants

**Files:**

- Modify: `core/asyncapi.yaml`
- Modify: `core/src/schemas.ts`
- Modify: `core/src/adapter.ts`
- Modify: `server/src/constants.ts`
- Modify: `server/src/types.ts`
- Modify (mocks only): `server/__tests__/agentRuntime.restorePty.test.ts`, `server/__tests__/agentRuntime.restorePalette.test.ts`, `server/__tests__/backgroundAgents.test.ts`, `server/__tests__/agentStateStore.test.ts`
- Generated: `core/src/messages.ts`

**Interfaces:**

- Produces `ClosedSession`, `ClosedSessionSummary` (core/src/schemas.ts); `StateAdapter.loadClosedSessions/saveClosedSessions/loadAgentOrder/saveAgentOrder`; `CloseSnapshot` + `AgentState.closing` (server/src/types.ts); `CLOSE_GRACE_MS`, `CLOSED_SESSIONS_MAX`; wire variants `agentClosing`, `closedSessions`, `agentOrder`, `undoClose`, `restoreSession`, `forgetClosedSession`, `reorderAgents`; `agentCreated.seatId/restored`; `existingAgents.agentOrder/closedSessions/closingAgents`.

- [ ] **Step 1: Add the schemas to `core/asyncapi.yaml`**

In the `ServerMessage.oneOf` list, after `- $ref: '#/components/schemas/ExistingAgents'` add:

```yaml
- $ref: '#/components/schemas/AgentClosing'
- $ref: '#/components/schemas/ClosedSessions'
- $ref: '#/components/schemas/AgentOrder'
```

In the `ClientMessage.oneOf` list, after `- $ref: '#/components/schemas/AcknowledgeCrash'` add:

```yaml
- $ref: '#/components/schemas/UndoClose'
- $ref: '#/components/schemas/RestoreSession'
- $ref: '#/components/schemas/ForgetClosedSession'
- $ref: '#/components/schemas/ReorderAgents'
```

Under `components.schemas`, right after the `AgentClosed` schema, add:

```yaml
AgentClosing:
  description: >-
    An agent entered the close grace window. The character and rail entry
    disappear now; the process stays alive for graceMs so undoClose can
    bring it back untouched. Followed by agentClosed (window elapsed) or
    agentCreated with restored=true (undone).
  type: object
  additionalProperties: false
  required: [type, id, graceMs]
  properties:
    type:
      const: agentClosing
    id:
      type: integer
    graceMs:
      type: integer

ClosedSessionSummary:
  description: >-
    A closed in-office session the user can restore. Paths stay server-side;
    this carries only what the Closed list renders.
  type: object
  additionalProperties: false
  required: [sessionId, terminalName, closedAt]
  properties:
    sessionId:
      type: string
    terminalName:
      type: string
    customTitle:
      type: string
    closedAt:
      type: integer
      description: Epoch ms when the grace window elapsed.

ClosedSessions:
  description: The full Closed list, newest first. Sent after every change.
  type: object
  additionalProperties: false
  required: [type, sessions]
  properties:
    type:
      const: closedSessions
    sessions:
      type: array
      items:
        $ref: '#/components/schemas/ClosedSessionSummary'

AgentOrder:
  description: >-
    Rail order for top-level agents (ids, top to bottom). Ids not listed
    sort after it by id. Drives only the rail, never seating.
  type: object
  additionalProperties: false
  required: [type, order]
  properties:
    type:
      const: agentOrder
    order:
      type: array
      items:
        type: integer
```

In the `AgentCreated` schema `properties`, add after `terminalName`:

```yaml
seatId:
  type: string
  description: >-
    Preferred seat to re-take. Set by undoClose and restoreSession so the
    character returns to where it sat.
restored:
  type: boolean
  description: >-
    True when this re-creates an agent the client already saw (undo or
    restore). The client skips the spawn effect and does not steal focus.
```

In the `ExistingAgents` schema `properties`, add after `crashedAgentIds`:

```yaml
agentOrder:
  type: array
  description: Rail order (see AgentOrder).
  items:
    type: integer
closedSessions:
  type: array
  description: The Closed list (see ClosedSessions).
  items:
    $ref: '#/components/schemas/ClosedSessionSummary'
closingAgents:
  type: object
  description: >-
    Map of agent ID (string) to remaining grace ms for agents inside the
    close window. These ids are also in `agents`; the client must tear
    them down and show the undo toast instead of a character.
  additionalProperties:
    type: integer
```

Under the client variants (right after `CloseAgent`), add:

```yaml
UndoClose:
  description: Bring back an agent inside its close grace window. Privileged only.
  type: object
  additionalProperties: false
  required: [type, id]
  properties:
    type:
      const: undoClose
    id:
      type: integer

RestoreSession:
  description: >-
    Re-spawn a closed in-office session from the Closed list (claude --resume
    on its transcript). Privileged only.
  type: object
  additionalProperties: false
  required: [type, sessionId]
  properties:
    type:
      const: restoreSession
    sessionId:
      type: string

ForgetClosedSession:
  description: Drop an entry from the Closed list. Privileged only.
  type: object
  additionalProperties: false
  required: [type, sessionId]
  properties:
    type:
      const: forgetClosedSession
    sessionId:
      type: string

ReorderAgents:
  description: >-
    Set the rail order. The server keeps only current top-level ids and
    appends any it was not told about. Privileged only.
  type: object
  additionalProperties: false
  required: [type, order]
  properties:
    type:
      const: reorderAgents
    order:
      type: array
      items:
        type: integer
```

Also update `CloseAgent`'s description to end with "Privileged only." (it becomes privileged in Task 7).

- [ ] **Step 2: Validate and regenerate**

Run: `npm run asyncapi:validate && npm run asyncapi:generate`
Expected: both succeed; `git diff --stat core/src/messages.ts` shows changes. Open `core/src/messages.ts` and confirm an exported type for `ClosedSessionSummary` exists (note its exact name; later tasks import it as `ClosedSessionSummary`; if Modelina named it differently, use that name everywhere).

- [ ] **Step 3: Core types**

Append to `core/src/schemas.ts` after `PersistedAgent`:

```ts
/** A closed in-office session kept for restore. Persisted under
 *  `closedSessions` in standalone-state.json. One transcript ↔ one entry. */
export interface ClosedSession {
  sessionId: string;
  jsonlFile: string;
  projectDir: string;
  terminalName: string;
  customTitle?: string;
  spawnCwd?: string;
  bypassPermissions?: boolean;
  palette?: number;
  hueShift?: number;
  /** Seat preference at close time. */
  seatId?: string;
  /** Rail index at close time; restore re-inserts here (clamped). */
  railIndex: number;
  closedAt: number;
}
```

`ClosedSessionSummary` is NOT hand-written: Modelina generates it into `core/src/messages.ts` from the AsyncAPI schema (same as `AgentSeatMeta`). Server and webview both import it from there, so the two cannot drift.

In `core/src/adapter.ts`, change the import to `import type { ClosedSession, PersistedAgent } from './schemas.js';` and add to `StateAdapter` after `saveSeats`:

```ts
  // ── Closed sessions + rail order (standalone; VS Code never writes them) ─

  loadClosedSessions(): ClosedSession[];
  saveClosedSessions(sessions: ClosedSession[]): void;

  loadAgentOrder(): number[];
  saveAgentOrder(order: number[]): void;
```

- [ ] **Step 4: Server types + constants**

In `server/src/types.ts`, inside `AgentState` after `bypassPermissions`:

```ts
  /** Set while the agent is inside the close grace window (closeAgent →
   *  finalize/undo). A snapshot taken at the click so later churn (seat saves,
   *  a racing move) cannot change what undo or finalize see. Runtime-only. */
  closing?: CloseSnapshot & { since: number };
```

and after the interface:

```ts
/** What closeAgent records at the click. */
export interface CloseSnapshot {
  /** Persisted seat preference at click time. */
  seatId?: string;
  /** Rail position at click time (-1 when unknown). */
  railIndex: number;
  /** Which finalize branch applies: in-office pty (record + kill) or adopted (remove only). */
  ptyBacked: boolean;
}
```

In `server/src/constants.ts` append:

```ts
// ── Undo close / Closed list ─────────────────────────────────
/** How long a closed agent's process stays alive for undo. */
export const CLOSE_GRACE_MS = 10_000;
/** Max entries on the Closed (restorable sessions) list. */
export const CLOSED_SESSIONS_MAX = 10;
```

- [ ] **Step 5: Fix the StateAdapter mocks so types compile**

Every object literal typed `StateAdapter` in the four test files above gains:

```ts
    loadClosedSessions: () => [],
    saveClosedSessions: () => {},
    loadAgentOrder: () => [],
    saveAgentOrder: () => {},
```

Find them with `grep -n "loadSeats: " server/__tests__/*.ts`.

- [ ] **Step 6: Type-check and run the server suite**

Run: `npm run check-types && npm run test:server`
Expected: PASS (FileStateAdapter does not compile yet? It must: add the four methods there NOW as thin stubs returning `[]`/no-op if the compiler complains, Task 2 replaces them).

- [ ] **Step 7: Commit**

```bash
git add core/asyncapi.yaml core/src/messages.ts core/src/schemas.ts core/src/adapter.ts server/src/constants.ts server/src/types.ts server/__tests__ server/src/fileStateAdapter.ts
git commit -m "feat(core): protocol + types for undo close, closed sessions and rail order"
```

---

### Task 2: FileStateAdapter round-trips `closedSessions` and `agentOrder`

**Files:**

- Modify: `server/src/fileStateAdapter.ts:34-133`
- Test: `server/__tests__/fileStateAdapter.test.ts`

**Interfaces:**

- Consumes `ClosedSession` from `core/src/schemas.js`.
- Produces the four adapter methods with the malformed→default rule; every write preserves the other keys.

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/fileStateAdapter.test.ts` (reuse its existing temp-HOME `beforeEach`/`afterEach`; if the file builds adapters via a helper, use it):

```ts
describe('closedSessions + agentOrder', () => {
  const record = {
    sessionId: 'sess-a',
    jsonlFile: '/tmp/a.jsonl',
    projectDir: '/tmp',
    terminalName: 'Claude Code #1',
    railIndex: 0,
    closedAt: 1,
  };

  it('round-trips closedSessions and agentOrder independently of agents/seats', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.saveClosedSessions([record]);
    adapter.saveAgentOrder([3, 1, 2]);
    // A later seats save must not erase either key.
    adapter.saveSeats({ '1': { seatId: 'chair-1' } });
    adapter.saveAgents([]);
    expect(adapter.loadClosedSessions()).toEqual([record]);
    expect(adapter.loadAgentOrder()).toEqual([3, 1, 2]);
    expect(adapter.loadSeats()).toEqual({ '1': { seatId: 'chair-1' } });
  });

  it('malformed values load as empty', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    // The file isolates via vi.mock('os', homedir: () => tempHome) — NOT
    // process.env.HOME. Build the path from tempHome or the test overwrites
    // the developer's real ~/.pixel-agents/standalone-state.json.
    const file = path.join(tempHome, '.pixel-agents', 'standalone-state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ agents: [], seats: {}, closedSessions: 'x', agentOrder: { a: 1 } }),
    );
    expect(adapter.loadClosedSessions()).toEqual([]);
    expect(adapter.loadAgentOrder()).toEqual([]);
  });

  it('agentOrder keeps only integers', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const file = path.join(tempHome, '.pixel-agents', 'standalone-state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agents: [], seats: {}, agentOrder: [1, 'x', 2.5, 3] }));
    expect(adapter.loadAgentOrder()).toEqual([1, 3]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/fileStateAdapter.test.ts`
Expected: FAIL (methods missing or returning stubs that lose data).

- [ ] **Step 3: Implement**

In `server/src/fileStateAdapter.ts`:

```ts
import type { ClosedSession, PersistedAgent } from '../../core/src/schemas.js'; // adjust to the file's existing import of PersistedAgent

interface AdapterState {
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  closedSessions: ClosedSession[];
  agentOrder: number[];
}

const EMPTY_STATE: AdapterState = { agents: [], seats: {}, closedSessions: [], agentOrder: [] };
```

Methods (after `saveSeats`):

```ts
  loadClosedSessions(): ClosedSession[] {
    return this.readState().closedSessions;
  }

  saveClosedSessions(sessions: ClosedSession[]): void {
    const state = this.readState();
    state.closedSessions = sessions;
    this.writeState(state);
  }

  loadAgentOrder(): number[] {
    return this.readState().agentOrder;
  }

  saveAgentOrder(order: number[]): void {
    const state = this.readState();
    state.agentOrder = order;
    this.writeState(state);
  }
```

`readState` returns the two new keys with the malformed rule:

```ts
return {
  agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
  seats:
    parsed.seats && typeof parsed.seats === 'object' ? (parsed.seats as AdapterState['seats']) : {},
  closedSessions: Array.isArray(parsed.closedSessions)
    ? (parsed.closedSessions as ClosedSession[])
    : [],
  agentOrder: Array.isArray(parsed.agentOrder)
    ? (parsed.agentOrder as unknown[]).filter((v): v is number => Number.isInteger(v))
    : [],
};
```

and the early-return / catch paths return `{ ...EMPTY_STATE }`.

- [ ] **Step 4: Run the test**

Run: `cd server && npx vitest run __tests__/fileStateAdapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/fileStateAdapter.ts server/__tests__/fileStateAdapter.test.ts
git commit -m "feat(server): persist closedSessions and agentOrder in the adapter state file"
```

---

### Task 3: `ClosedSessions` list

**Files:**

- Create: `server/src/closedSessions.ts`
- Test: `server/__tests__/closedSessions.test.ts`

**Interfaces:**

- Produces:

```ts
export class ClosedSessions {
  constructor(adapter?: StateAdapter);
  load(): void; // from adapter
  list(): ClosedSession[]; // newest first, copy
  summaries(): ClosedSessionSummary[];
  get(sessionId: string): ClosedSession | undefined;
  push(record: ClosedSession): void; // dedupe by sessionId (newest wins), prepend, trim, save
  remove(sessionId: string): boolean; // save when removed
  dropMatching(agent: { sessionId: string; jsonlFile: string }): boolean; // save when removed
}
```

- [ ] **Step 1: Write the failing tests**

`server/__tests__/closedSessions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { ClosedSession } from '../../core/src/schemas.js';
import { ClosedSessions } from '../src/closedSessions.js';
import { CLOSED_SESSIONS_MAX } from '../src/constants.js';

function rec(sessionId: string, overrides: Partial<ClosedSession> = {}): ClosedSession {
  return {
    sessionId,
    jsonlFile: `/p/${sessionId}.jsonl`,
    projectDir: '/p',
    terminalName: `Claude Code #${sessionId}`,
    railIndex: 0,
    closedAt: 1,
    ...overrides,
  };
}

function adapterWith(initial: ClosedSession[] = []) {
  const saved: ClosedSession[][] = [];
  const adapter = {
    loadAgents: () => [],
    saveAgents: () => {},
    loadSeats: () => ({}),
    saveSeats: () => {},
    loadClosedSessions: () => initial,
    saveClosedSessions: vi.fn((s: ClosedSession[]) => saved.push([...s])),
    loadAgentOrder: () => [],
    saveAgentOrder: () => {},
    getSetting: <T>(_k: string, d: T) => d,
    setSetting: () => {},
  } as unknown as StateAdapter;
  return { adapter, saved };
}

describe('ClosedSessions', () => {
  it('push prepends, dedupes by sessionId (newest wins) and saves', () => {
    const { adapter, saved } = adapterWith();
    const list = new ClosedSessions(adapter);
    list.push(rec('a', { closedAt: 1 }));
    list.push(rec('b', { closedAt: 2 }));
    list.push(rec('a', { closedAt: 3, customTitle: 'again' }));
    expect(list.list().map((r) => r.sessionId)).toEqual(['a', 'b']);
    expect(list.get('a')?.customTitle).toBe('again');
    expect(saved).toHaveLength(3);
  });

  it('trims to CLOSED_SESSIONS_MAX', () => {
    const list = new ClosedSessions(adapterWith().adapter);
    for (let i = 0; i < CLOSED_SESSIONS_MAX + 3; i++) list.push(rec(`s${i}`));
    expect(list.list()).toHaveLength(CLOSED_SESSIONS_MAX);
    expect(list.list()[0].sessionId).toBe(`s${CLOSED_SESSIONS_MAX + 2}`);
  });

  it('remove returns whether something was removed and saves only then', () => {
    const { adapter, saved } = adapterWith();
    const list = new ClosedSessions(adapter);
    list.push(rec('a'));
    expect(list.remove('zzz')).toBe(false);
    expect(saved).toHaveLength(1);
    expect(list.remove('a')).toBe(true);
    expect(saved).toHaveLength(2);
    expect(list.list()).toEqual([]);
  });

  it('dropMatching removes by sessionId OR jsonlFile', () => {
    const list = new ClosedSessions(adapterWith().adapter);
    list.push(rec('a'));
    list.push(rec('b'));
    expect(list.dropMatching({ sessionId: 'other', jsonlFile: '/p/b.jsonl' })).toBe(true);
    expect(list.dropMatching({ sessionId: 'a', jsonlFile: '/elsewhere' })).toBe(true);
    expect(list.dropMatching({ sessionId: 'none', jsonlFile: '/none' })).toBe(false);
    expect(list.list()).toEqual([]);
  });

  it('load reads the adapter; summaries carry no paths', () => {
    const { adapter } = adapterWith([rec('a', { customTitle: 'Zed' })]);
    const list = new ClosedSessions(adapter);
    list.load();
    expect(list.summaries()).toEqual([
      { sessionId: 'a', terminalName: 'Claude Code #a', customTitle: 'Zed', closedAt: 1 },
    ]);
  });

  it('works without an adapter (in-memory only)', () => {
    const list = new ClosedSessions();
    list.load();
    list.push(rec('a'));
    expect(list.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/closedSessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/closedSessions.ts`**

```ts
import type { StateAdapter } from '../../core/src/adapter.js';
import type { ClosedSessionSummary } from '../../core/src/messages.js';
import type { ClosedSession } from '../../core/src/schemas.js';
import { CLOSED_SESSIONS_MAX } from './constants.js';

/**
 * The Closed list: in-office sessions whose close grace window elapsed. Kept
 * so the user can restore one later (claude --resume on its transcript).
 * Newest first, capped, persisted through the adapter on every change.
 * `finalizeClose` is the only writer; every other removal path never lands here.
 */
export class ClosedSessions {
  private records: ClosedSession[] = [];

  constructor(private readonly adapter?: StateAdapter) {}

  load(): void {
    this.records = this.adapter?.loadClosedSessions() ?? [];
  }

  list(): ClosedSession[] {
    return [...this.records];
  }

  summaries(): ClosedSessionSummary[] {
    return this.records.map((r) => ({
      sessionId: r.sessionId,
      terminalName: r.terminalName,
      customTitle: r.customTitle,
      closedAt: r.closedAt,
    }));
  }

  get(sessionId: string): ClosedSession | undefined {
    return this.records.find((r) => r.sessionId === sessionId);
  }

  push(record: ClosedSession): void {
    this.records = [record, ...this.records.filter((r) => r.sessionId !== record.sessionId)].slice(
      0,
      CLOSED_SESSIONS_MAX,
    );
    this.save();
  }

  remove(sessionId: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.sessionId !== sessionId);
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  /** A session that is live again (adopted from outside, resumed elsewhere)
   *  must not stay restorable: a second --resume on it would fork the transcript. */
  dropMatching(agent: { sessionId: string; jsonlFile: string }): boolean {
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => r.sessionId !== agent.sessionId && r.jsonlFile !== agent.jsonlFile,
    );
    if (this.records.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    try {
      this.adapter?.saveClosedSessions(this.records);
    } catch (err) {
      console.error('[Pixel Agents] Failed to save closed sessions:', err);
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `cd server && npx vitest run __tests__/closedSessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/closedSessions.ts server/__tests__/closedSessions.test.ts
git commit -m "feat(server): ClosedSessions list (capped, deduped, persisted)"
```

---

### Task 4: `AgentStateStore` rail order + `agentAdded` extra

**Files:**

- Modify: `server/src/agentStateStore.ts`
- Test: `server/__tests__/agentStateStore.test.ts`

**Interfaces:**

- Produces:

```ts
export interface AgentAddedExtra { seatId?: string; restored?: boolean }
// StoreEvents.agentAdded: (id, agent, extra?: AgentAddedExtra) => void
store.set(id, agent, extra?: AgentAddedExtra): this
store.agentOrder: number[]            // getter, copy
store.reorder(order: number[]): number[]  // sanitize + persist + return applied order
store.insertInOrder(id: number, index: number): void // clamp, dedupe, persist
```

- `persist()` also saves the order. `setAdapter` loads it.
- Top-level = `agent.leadAgentId === undefined && !agent.spawnToolUseId`.

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/agentStateStore.test.ts` (reuse its `createTestAgent`/mock adapter helpers; the mock adapter must record `saveAgentOrder` calls — extend it with `let order: number[] = []; loadAgentOrder: () => order, saveAgentOrder: (o) => { order = [...o]; }`):

```ts
describe('rail order', () => {
  it('appends top-level agents on set and removes on delete', () => {
    const store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2 }));
    store.set(1, createTestAgent({ id: 1 }));
    store.set(7, createTestAgent({ id: 7, leadAgentId: 1, teamName: 't' })); // teammate: not ordered
    store.set(8, createTestAgent({ id: 8, spawnToolUseId: 'toolu_x' })); // spawn: not ordered
    expect(store.agentOrder).toEqual([2, 1]);
    store.delete(2);
    expect(store.agentOrder).toEqual([1]);
  });

  it('reorder keeps only current top-level ids and appends omitted ones', () => {
    const store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2 }));
    store.set(3, createTestAgent({ id: 3 }));
    expect(store.reorder([3, 99, 1, 3])).toEqual([3, 1, 2]);
    expect(store.agentOrder).toEqual([3, 1, 2]);
  });

  it('insertInOrder clamps and dedupes', () => {
    const store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2 }));
    store.insertInOrder(2, 0);
    expect(store.agentOrder).toEqual([2, 1]);
    store.insertInOrder(5, 99);
    expect(store.agentOrder).toEqual([2, 1, 5]);
    store.insertInOrder(6, -1);
    expect(store.agentOrder).toEqual([2, 1, 5, 6]);
  });

  it('persist writes the order; setAdapter loads it', () => {
    const adapter = createMockAdapter(); // the test file's helper, extended as described
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    store.set(4, createTestAgent({ id: 4 }));
    store.set(3, createTestAgent({ id: 3 }));
    store.persist();
    const second = new AgentStateStore();
    second.setAdapter(adapter);
    expect(second.agentOrder).toEqual([4, 3]);
  });

  it('agentAdded passes the extra through', () => {
    const store = new AgentStateStore();
    const seen: unknown[] = [];
    store.on('agentAdded', (_id, _agent, extra) => seen.push(extra));
    store.set(1, createTestAgent({ id: 1 }), { seatId: 'chair-2', restored: true });
    store.set(2, createTestAgent({ id: 2 }));
    expect(seen).toEqual([{ seatId: 'chair-2', restored: true }, undefined]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/agentStateStore.test.ts`
Expected: FAIL — `agentOrder`/`reorder`/`insertInOrder` undefined; extra not delivered.

- [ ] **Step 3: Implement**

In `server/src/agentStateStore.ts`:

```ts
/** Optional detail riding on agentAdded: set by undo/restore so the single
 *  agentCreated the client sees carries the seat to re-take. */
export interface AgentAddedExtra {
  seatId?: string;
  restored?: boolean;
}

export interface StoreEvents {
  agentAdded: (id: number, agent: AgentState, extra?: AgentAddedExtra) => void;
  // ...unchanged
}
```

Fields + helpers inside the class:

```ts
  /** Rail order: top-level agent ids, top to bottom. May hold stale ids; readers filter. */
  private order: number[] = [];

  get agentOrder(): number[] {
    return [...this.order];
  }

  private static isTopLevel(agent: AgentState): boolean {
    return agent.leadAgentId === undefined && !agent.spawnToolUseId;
  }

  /** Apply a client-supplied order: keep known top-level ids (first occurrence),
   *  append current top-level agents the client omitted, persist. */
  reorder(order: number[]): number[] {
    const current = [...this.agents.values()].filter(AgentStateStore.isTopLevel).map((a) => a.id);
    const currentSet = new Set(current);
    const next: number[] = [];
    for (const id of order) {
      if (currentSet.has(id) && !next.includes(id)) next.push(id);
    }
    for (const id of current) if (!next.includes(id)) next.push(id);
    this.order = next;
    this.saveOrder();
    return this.agentOrder;
  }

  /** Negative index = unknown position = append (a Closed record whose rail
   *  index was never known must not jump to the top on restore). */
  insertInOrder(id: number, index: number): void {
    this.order = this.order.filter((v) => v !== id);
    const at = index < 0 ? this.order.length : Math.min(index, this.order.length);
    this.order.splice(at, 0, id);
    this.saveOrder();
  }

  private saveOrder(): void {
    try {
      this.adapter?.saveAgentOrder(this.order);
    } catch (err) {
      console.error('[Pixel Agents] Failed to save agent order:', err);
    }
  }
```

`setAdapter` becomes:

```ts
  setAdapter(adapter: StateAdapter): void {
    this.adapter = adapter;
    this.order = adapter.loadAgentOrder();
  }
```

`set`/`delete`:

```ts
  set(id: number, agent: AgentState, extra?: AgentAddedExtra): this {
    const isNew = !this.agents.has(id);
    this.agents.set(id, agent);
    if (isNew) {
      if (AgentStateStore.isTopLevel(agent) && !this.order.includes(id)) this.order.push(id);
      this.emitter.emit('agentAdded', id, agent, extra);
    }
    return this;
  }

  delete(id: number): boolean {
    const existed = this.agents.delete(id);
    if (existed) {
      this.order = this.order.filter((v) => v !== id);
      this.emitter.emit('agentRemoved', id);
    }
    return existed;
  }
```

`persist()` ends with `this.adapter.saveAgents(persisted); this.saveOrder();`.

- [ ] **Step 4: Run the store suite and the whole server suite**

Run: `cd server && npx vitest run __tests__/agentStateStore.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/agentStateStore.ts server/__tests__/agentStateStore.test.ts
git commit -m "feat(server): store-owned rail order; agentAdded carries an optional extra"
```

---

### Task 5: One `agentCreated` builder

**Files:**

- Create: `server/src/agentCreatedMessage.ts`
- Modify: `server/src/httpServer.ts:177-198`
- Test: `server/__tests__/agentCreatedMessage.test.ts`

**Interfaces:**

- Produces `agentCreatedMessage(id: number, agent: AgentState, extra?: AgentAddedExtra): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { agentCreatedMessage } from '../src/agentCreatedMessage.js';
import type { AgentState } from '../src/types.js';

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 5,
    sessionId: 's',
    isExternal: false,
    projectDir: '/p',
    jsonlFile: '/p/s.jsonl',
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
    ...overrides,
  } as AgentState;
}

describe('agentCreatedMessage', () => {
  it('matches the historical httpServer payload shape with no extra', () => {
    const msg = agentCreatedMessage(
      5,
      agent({
        folderName: 'proj',
        palette: 2,
        hueShift: 90,
        ptyBacked: true,
        customTitle: 'Zed',
        terminalRef: { name: 'Claude Code #3' } as vscode.Terminal,
      }),
    );
    expect(msg).toEqual({
      type: 'agentCreated',
      id: 5,
      folderName: 'proj',
      isExternal: undefined,
      isTeammate: undefined,
      teammateName: undefined,
      parentAgentId: undefined,
      teamName: undefined,
      hooksOnly: undefined,
      palette: 2,
      hueShift: 90,
      ptyBacked: true,
      customTitle: 'Zed',
      terminalName: 'Claude Code #3',
    });
  });

  it('adds seatId/restored only when given', () => {
    const msg = agentCreatedMessage(1, agent(), { seatId: 'chair-1', restored: true });
    expect(msg.seatId).toBe('chair-1');
    expect(msg.restored).toBe(true);
    expect('seatId' in agentCreatedMessage(1, agent())).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/agentCreatedMessage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/agentCreatedMessage.ts`:

```ts
import type { AgentAddedExtra } from './agentStateStore.js';
import type { AgentState } from './types.js';

/**
 * The ONE shape of `agentCreated`. httpServer emits it on the store's
 * agentAdded event; undoClose and restoreSession broadcast it explicitly (with
 * the seat to re-take). Keep the field list identical to what the socket
 * closure sent before this module existed — the webview keys on it.
 */
export function agentCreatedMessage(
  id: number,
  agent: AgentState,
  extra?: AgentAddedExtra,
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: 'agentCreated',
    id,
    folderName: agent.folderName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    parentAgentId: agent.leadAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    palette: agent.palette,
    hueShift: agent.hueShift,
    ptyBacked: agent.ptyBacked || undefined,
    customTitle: agent.customTitle,
    // Live AgentState has no terminalName field; source it from terminalRef.name
    // (same as agentStateStore.persist).
    terminalName: agent.terminalRef?.name || undefined,
  };
  if (extra?.seatId !== undefined) msg.seatId = extra.seatId;
  if (extra?.restored) msg.restored = true;
  return msg;
}
```

In `server/src/httpServer.ts` replace the body of `onAgentAdded` with:

```ts
const onAgentAdded = (id: number, agent: AgentState, extra?: AgentAddedExtra) => {
  safeSend(socket, agentCreatedMessage(id, agent, extra));
};
```

and import `agentCreatedMessage` + `AgentAddedExtra` (type).

- [ ] **Step 4: Run the server suite**

Run: `cd server && npm test`
Expected: PASS (server.test.ts still sees the same `agentCreated` payload).

- [ ] **Step 5: Commit**

```bash
git add server/src/agentCreatedMessage.ts server/src/httpServer.ts server/__tests__/agentCreatedMessage.test.ts
git commit -m "refactor(server): single agentCreated builder shared by socket emit, undo and restore"
```

---

### Task 6: `AgentRuntime` grace window, finalize, undo, dispose ordering

**Files:**

- Modify: `server/src/agentRuntime.ts`
- Test: `server/__tests__/agentRuntime.closeGrace.test.ts`

**Interfaces:**

- Consumes `ClosedSessions` (Task 3), `CloseSnapshot` (Task 1), `store.agentOrder` (Task 4).
- Produces on `AgentRuntime`:

```ts
readonly closeGraceTimers: Map<number, ReturnType<typeof setTimeout>>;
get closedSessions(): ClosedSessions | null;        // non-null after setPtyHost
beginClose(id: number, snapshot: CloseSnapshot): boolean; // false when unknown/already closing; arms timer; dismisses adopted
undoClose(id: number): AgentState | null;           // cancels timer, clears closing, undismisses adopted
finalizeClose(id: number): void;                    // record (pty) + removeAgent; broadcasts closedSessions
broadcastClosedSessions(): void;
```

- [ ] **Step 1: Write the failing tests**

`server/__tests__/agentRuntime.closeGrace.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CLOSE_GRACE_MS } from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { PtyManager } from '../src/pty/ptyManager.js';
import type { AgentState } from '../src/types.js';

function makeAgent(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `sess-${id}`,
    terminalRef: { name: `Claude Code #${id}` } as vscode.Terminal,
    isExternal: false,
    projectDir: '/p',
    jsonlFile: `/p/sess-${id}.jsonl`,
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
    customTitle: `T${id}`,
    spawnCwd: '/p',
    ...overrides,
  } as AgentState;
}

function fakeHost() {
  const stops: number[] = [];
  const host = {
    start: vi.fn(),
    stop: vi.fn((id: number) => stops.push(id)),
    write: vi.fn(),
    resize: vi.fn(),
    scrollback: vi.fn(() => []),
    has: vi.fn(() => true),
    exitInfo: vi.fn(() => undefined),
    crashedAgentIds: vi.fn(() => []),
    markStopped: vi.fn(),
    disposeAll: vi.fn(),
  };
  return { host: host as unknown as PtyManager, stops };
}

describe('AgentRuntime close grace window', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-grace-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    runtime = new AgentRuntime(store, claudeProvider);
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('beginClose arms the timer without stopping the pty; finalize records, unregisters and removes', () => {
    const { host, stops } = fakeHost();
    runtime.setPtyHost(host);
    store.set(1, makeAgent(1));
    store.set(2, makeAgent(2));
    expect(runtime.beginClose(1, { seatId: 'chair-1', railIndex: 0, ptyBacked: true })).toBe(true);
    expect(store.get(1)?.closing?.seatId).toBe('chair-1');
    expect(stops).toEqual([]);
    expect(runtime.beginClose(1, { railIndex: 0, ptyBacked: true })).toBe(false); // already closing

    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(stops).toEqual([1]);
    const rec = runtime.closedSessions!.list();
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      sessionId: 'sess-1',
      seatId: 'chair-1',
      railIndex: 0,
      customTitle: 'T1',
    });
    expect(broadcasts.at(-1)).toMatchObject({ type: 'closedSessions' });
    expect(store.agentOrder).toEqual([2]);
  });

  it('undoClose cancels the timer and clears the snapshot', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    expect(runtime.undoClose(1)?.id).toBe(1);
    expect(store.get(1)?.closing).toBeUndefined();
    expect(runtime.undoClose(1)).toBeNull(); // not closing any more
    vi.advanceTimersByTime(CLOSE_GRACE_MS * 2);
    expect(store.has(1)).toBe(true);
    expect(runtime.closedSessions!.list()).toEqual([]);
  });

  it('an adopted session is dismissed on begin and undismissed on undo; finalize never records it', () => {
    runtime.setPtyHost(fakeHost().host);
    const adopted = makeAgent(3, {
      ptyBacked: undefined,
      isExternal: true,
      terminalRef: undefined,
    });
    store.set(3, adopted);
    runtime.beginClose(3, { railIndex: 0, ptyBacked: false });
    expect(runtime.dismissalTracker.isDismissed(adopted.jsonlFile)).toBe(true);
    runtime.undoClose(3);
    expect(runtime.dismissalTracker.isDismissed(adopted.jsonlFile)).toBe(false);
    runtime.beginClose(3, { railIndex: 0, ptyBacked: false });
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(3)).toBe(false);
    expect(runtime.closedSessions!.list()).toEqual([]);
  });

  it('removeAgent through another path cancels the timer; finalize is a no-op', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    runtime.removeAgent(1); // e.g. external sessionEnd
    expect(runtime.closeGraceTimers.has(1)).toBe(false);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(runtime.closedSessions!.list()).toEqual([]);
  });

  it('dispose inside the window finalizes the record and omits the agent from the persisted list', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    store.set(2, makeAgent(2));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    runtime.dispose();
    const adapter = store.getAdapter()!;
    expect(adapter.loadAgents().map((a) => a.id)).toEqual([2]);
    expect(adapter.loadClosedSessions().map((r) => r.sessionId)).toEqual(['sess-1']);
    expect(adapter.loadAgentOrder()).toEqual([2]);
  });

  it('dispose with a closing ADOPTED agent writes no record', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(3, makeAgent(3, { ptyBacked: undefined, isExternal: true, terminalRef: undefined }));
    runtime.beginClose(3, { railIndex: 0, ptyBacked: false });
    runtime.dispose();
    expect(store.getAdapter()!.loadClosedSessions()).toEqual([]);
  });

  it('an agent appearing for a closed session drops its record', () => {
    runtime.setPtyHost(fakeHost().host);
    store.set(1, makeAgent(1));
    runtime.beginClose(1, { railIndex: 0, ptyBacked: true });
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(runtime.closedSessions!.list()).toHaveLength(1);
    store.set(
      9,
      makeAgent(9, { sessionId: 'sess-1', jsonlFile: '/p/sess-1.jsonl', isExternal: true }),
    );
    expect(runtime.closedSessions!.list()).toEqual([]);
    expect(broadcasts.at(-1)).toMatchObject({ type: 'closedSessions', sessions: [] });
  });
});
```

If `DismissalTracker` has no `isDismissed(path)`, check `server/src/dismissalTracker.ts` for the query method name (the file watcher uses one) and use that.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/agentRuntime.closeGrace.test.ts`
Expected: FAIL — `beginClose` not a function.

- [ ] **Step 3: Implement in `server/src/agentRuntime.ts`**

Imports: `import { ClosedSessions } from './closedSessions.js';`, `import { CLOSE_GRACE_MS, ... } from './constants.js';`, `import type { AgentState, CloseSnapshot } from './types.js';` (merge with the existing imports).

Fields:

```ts
  /** Close grace timers, keyed by agent id (closeAgent → finalizeClose). */
  readonly closeGraceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The Closed list. Created with the pty host: meaningless without one. */
  private _closedSessions: ClosedSessions | null = null;
```

In the constructor, after the existing callbacks are wired:

```ts
// A session that comes back by itself (adopted from outside, --resume'd in
// another terminal) must leave the Closed list: a Restore on it would fork
// the transcript.
store.on('agentAdded', (_id, agent) => {
  if (this._closedSessions?.dropMatching(agent)) this.broadcastClosedSessions();
});
```

Accessors and the window API (place after `get ptyHost()`):

```ts
  get closedSessions(): ClosedSessions | null {
    return this._closedSessions;
  }

  broadcastClosedSessions(): void {
    if (!this._closedSessions) return;
    this.store.broadcast({ type: 'closedSessions', sessions: this._closedSessions.summaries() });
  }

  /** Start the close grace window. The process and watchers keep running;
   *  only the timer and the snapshot change. False when the agent is unknown
   *  or already closing. */
  beginClose(id: number, snapshot: CloseSnapshot): boolean {
    const agent = this.store.get(id);
    if (!agent || agent.closing) return false;
    agent.closing = { ...snapshot, since: Date.now() };
    if (!snapshot.ptyBacked) {
      // Adopted session: keep the external scanner from re-adopting it mid-window.
      this.dismissalTracker.dismiss(agent.jsonlFile);
    }
    const timer = setTimeout(() => this.finalizeClose(id), CLOSE_GRACE_MS);
    this.closeGraceTimers.set(id, timer);
    return true;
  }

  /** Cancel the window. Returns the agent so the caller can re-announce it. */
  undoClose(id: number): AgentState | null {
    const agent = this.store.get(id);
    if (!agent?.closing) return null;
    this.clearCloseTimer(id);
    const wasAdopted = !agent.closing.ptyBacked;
    delete agent.closing;
    if (wasAdopted) this.dismissalTracker.clearDismissal(agent.jsonlFile);
    return agent;
  }

  /** The window elapsed: in-office agents become a Closed record and die;
   *  adopted ones are simply removed (their dismissal was recorded on begin).
   *  The ONLY writer of the Closed list. */
  finalizeClose(id: number): void {
    this.clearCloseTimer(id);
    const agent = this.store.get(id);
    if (!agent?.closing) return;
    const snap = agent.closing;
    if (snap.ptyBacked && this._closedSessions) {
      this._closedSessions.push({
        sessionId: agent.sessionId,
        jsonlFile: agent.jsonlFile,
        projectDir: agent.projectDir,
        terminalName: agent.terminalRef?.name ?? '',
        customTitle: agent.customTitle,
        spawnCwd: agent.spawnCwd,
        bypassPermissions: agent.bypassPermissions || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        seatId: snap.seatId,
        railIndex: snap.railIndex < 0 ? this.store.agentOrder.indexOf(id) : snap.railIndex,
        closedAt: Date.now(),
      });
      this.unregisterAgent(agent.sessionId);
    }
    // Parity with the old immediate close: keep any scan path from re-adopting
    // the dying process's last JSONL flush (which would drop the record via
    // dropMatching).
    this.dismissalTracker.dismiss(agent.jsonlFile);
    this.removeAgent(id);
    if (snap.ptyBacked) this.broadcastClosedSessions();
  }

  private clearCloseTimer(id: number): void {
    const t = this.closeGraceTimers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.closeGraceTimers.delete(id);
  }
```

`setPtyHost`:

```ts
  setPtyHost(host: PtyManager): void {
    this._ptyHost = host;
    this._closedSessions = new ClosedSessions(this.store.getAdapter());
    this._closedSessions.load();
  }
```

`removeAgent`: add `this.clearCloseTimer(id);` right after the `if (!agent) return;` guard.

`dispose()`: make it idempotent (tests call it explicitly AND in afterEach) with `if (this.disposing) return;` as its first statement, then before `this._ptyHost?.disposeAll();` insert:

```ts
// Closing agents are closed for good: record them, drop them from the
// list the next daemon restores, and persist ONCE before `disposing`
// suppresses removeAgent's own persist.
const closing = [...this.store.values()].filter((a) => a.closing).map((a) => a.id);
if (closing.length > 0) {
  for (const id of closing) this.finalizeClose(id);
  this.store.persist();
}
```

(`finalizeClose` calls `removeAgent`, which persists while `disposing` is still false; the explicit `persist()` is belt and braces for the order file. Keep both.)

- [ ] **Step 4: Run the test and the suite**

Run: `cd server && npx vitest run __tests__/agentRuntime.closeGrace.test.ts && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/agentRuntime.ts server/__tests__/agentRuntime.closeGrace.test.ts
git commit -m "feat(server): close grace window on AgentRuntime (begin/undo/finalize, dispose ordering)"
```

---

### Task 7: `closeAgent` (grace), `undoClose`, `forgetClosedSession`, `reorderAgents`, handshake fields, per-agent resend, move refusal

**Files:**

- Modify: `server/src/clientMessageHandler.ts` (closeAgent case ~114; new cases; `handleWebviewReady` existingAgents assembly ~688-706 and the final resend)
- Modify: `server/src/agentActivityResend.ts`
- Modify: `server/src/moveSession.ts:45-64`
- Modify: `server/__tests__/moveSession.test.ts` (one case)
- Modify: `server/__tests__/clientMessageHandler.test.ts` (any `closeAgent` test that sends unprivileged must now pass `privileged: true`)
- Test: `server/__tests__/clientMessageHandler.close.test.ts`

**Interfaces:**

- Consumes `runtime.beginClose/undoClose/closedSessions/broadcastClosedSessions` (Task 6), `agentCreatedMessage` (Task 5), `store.reorder/agentOrder` (Task 4).
- Produces `resendAgentActivityFor(send, store, id, agent)` exported from `agentActivityResend.ts`; `resendAgentActivity` now skips agents with `closing` set.

- [ ] **Step 1: Write the failing tests**

`server/__tests__/clientMessageHandler.close.test.ts` — copy the `createTestAgent`, `makeFakePtyHost`, temp-HOME `beforeEach/afterEach`, `makeCtx` and `send` scaffolding from `server/__tests__/clientMessageHandler.pty.test.ts` verbatim (lines 16-121), add `markStopped: vi.fn()` to the fake host, and `vi.useFakeTimers()` in `beforeEach` / `vi.useRealTimers()` in `afterEach`. Then:

```ts
import { CLOSE_GRACE_MS } from '../src/constants.js';
import { moveRefusalReason } from '../src/moveSession.js';

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

describe('closeAgent with a grace window', () => {
  it('snapshots seat + rail index + kind, broadcasts agentClosing and keeps the pty alive', () => {
    const { host, running } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.getAdapter()!.saveSeats({ '1': { seatId: 'chair-7' } });
    store.set(1, ptyAgent(1));
    store.set(2, ptyAgent(2));
    running.add(1);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    expect(store.get(1)?.closing).toMatchObject({
      seatId: 'chair-7',
      railIndex: 0,
      ptyBacked: true,
    });
    expect(broadcasts).toContainEqual({ type: 'agentClosing', id: 1, graceMs: CLOSE_GRACE_MS });
    expect(running.has(1)).toBe(true);
  });

  it('is ignored for teammates, spawns, closing agents, in-flight moves and unprivileged clients', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1, { leadAgentId: 5 }));
    store.set(2, ptyAgent(2, { spawnToolUseId: 'toolu_1' }));
    store.set(3, ptyAgent(3, { moveInFlight: true }));
    store.set(4, ptyAgent(4));
    for (const id of [1, 2, 3]) handleClientMessage({ type: 'closeAgent', id }, send, ctx);
    handleClientMessage({ type: 'closeAgent', id: 4 }, send, ctx);
    handleClientMessage({ type: 'closeAgent', id: 4 }, send, ctx);
    expect(broadcasts.filter((b) => b.type === 'agentClosing')).toHaveLength(1);
    const unpriv = makeCtx(makeFakePtyHost().host, false);
    store.set(5, ptyAgent(5));
    handleClientMessage({ type: 'closeAgent', id: 5 }, send, unpriv);
    expect(store.get(5)?.closing).toBeUndefined();
  });

  it('seat snapshot survives a saveAgentSeats inside the window', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.getAdapter()!.saveSeats({ '1': { seatId: 'chair-7' } });
    store.set(1, ptyAgent(1));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    handleClientMessage({ type: 'saveAgentSeats', seats: {} }, send, ctx); // webview dropped the character
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    const created = broadcasts.find((b) => b.type === 'agentCreated');
    expect(created).toMatchObject({ id: 1, seatId: 'chair-7', restored: true, customTitle: 'T1' });
  });

  it('undoClose re-sends live state (team info, tools, waiting, context, crash)', () => {
    const { host, exits } = makeFakePtyHost();
    const ctx = makeCtx(host);
    const a = ptyAgent(1, { isTeamLead: true, isWaiting: true, contextTokens: 10 });
    a.activeToolStatuses.set('t1', 'Bash: ls');
    a.activeToolNames.set('t1', 'Bash');
    store.set(1, a);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    exits.set(1, { code: 1 }); // pty died inside the window
    broadcasts.length = 0;
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    const types = broadcasts.map((b) => b.type);
    expect(types[0]).toBe('agentCreated');
    expect(types).toEqual(
      expect.arrayContaining([
        'agentTeamInfo',
        'agentToolStart',
        'agentStatus',
        'agentContextUsage',
        'agentCrashed',
      ]),
    );
    expect(store.get(1)?.closing).toBeUndefined();
  });

  it('undoClose on an adopted session clears the dismissal and re-sends nothing pty-specific', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    const ext = createTestAgent({ id: 1, isExternal: true, jsonlFile: '/test/ext.jsonl' });
    store.set(1, ext);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    expect(runtime!.dismissalTracker.isDismissed('/test/ext.jsonl')).toBe(true);
    broadcasts.length = 0;
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    expect(runtime!.dismissalTracker.isDismissed('/test/ext.jsonl')).toBe(false);
    expect(broadcasts[0]).toMatchObject({
      type: 'agentCreated',
      id: 1,
      restored: true,
      isExternal: true,
    });
    expect(broadcasts.some((b) => b.type === 'agentCrashed')).toBe(false);
  });

  it('undoClose for a non-closing agent and unprivileged undo emit nothing', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1));
    handleClientMessage({ type: 'undoClose', id: 1 }, send, ctx);
    expect(broadcasts).toEqual([]);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    broadcasts.length = 0;
    handleClientMessage({ type: 'undoClose', id: 1 }, send, makeCtx(makeFakePtyHost().host, false));
    expect(broadcasts).toEqual([]);
  });

  it('finalize removes, unregisters, records and broadcasts closedSessions', () => {
    const { host, running } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.set(1, ptyAgent(1));
    running.add(1);
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(running.has(1)).toBe(false);
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'closedSessions',
      sessions: [{ sessionId: 'sess-1', terminalName: 'Claude Code #1', customTitle: 'T1' }],
    });
  });

  it('adopted sessions never enter the Closed list', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, createTestAgent({ id: 1, isExternal: true, jsonlFile: '/test/ext.jsonl' }));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(store.has(1)).toBe(false);
    expect(broadcasts.some((b) => b.type === 'closedSessions')).toBe(false);
  });

  it('forgetClosedSession drops the record', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    handleClientMessage({ type: 'forgetClosedSession', sessionId: 'sess-1' }, send, ctx);
    expect(broadcasts.at(-1)).toEqual({ type: 'closedSessions', sessions: [] });
  });

  it('reorderAgents sanitizes and broadcasts agentOrder', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    store.set(1, ptyAgent(1));
    store.set(2, ptyAgent(2));
    store.set(3, ptyAgent(3));
    handleClientMessage({ type: 'reorderAgents', order: [3, 42, 1] }, send, ctx);
    expect(broadcasts.at(-1)).toEqual({ type: 'agentOrder', order: [3, 1, 2] });
    handleClientMessage(
      { type: 'reorderAgents', order: [1, 2, 3] },
      send,
      makeCtx(makeFakePtyHost().host, false),
    );
    expect(store.agentOrder).toEqual([3, 1, 2]);
  });

  it('existingAgents carries agentOrder, closedSessions and closingAgents, and skips the closing agent in the resend', () => {
    const ctx = makeCtx(makeFakePtyHost().host);
    const a = ptyAgent(1, { isWaiting: true });
    store.set(1, a);
    store.set(2, ptyAgent(2));
    handleClientMessage({ type: 'closeAgent', id: 1 }, send, ctx);
    vi.advanceTimersByTime(1_000);
    sent.length = 0;
    handleClientMessage({ type: 'webviewReady' }, send, ctx);
    const existing = sent.find((m) => m.type === 'existingAgents')!;
    expect(existing.agentOrder).toEqual([1, 2]);
    expect(existing.closedSessions).toEqual([]);
    expect(existing.closingAgents).toEqual({ '1': CLOSE_GRACE_MS - 1_000 });
    expect(sent.some((m) => m.type === 'agentStatus' && m.id === 1)).toBe(false);
  });

  it('moveRefusalReason refuses a closing agent', () => {
    const a = createTestAgent({
      id: 1,
      isExternal: true,
      closing: { since: 0, railIndex: 0, ptyBacked: false },
    });
    expect(moveRefusalReason(a, true)).toMatch(/closing/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.close.test.ts`
Expected: FAIL across the board.

- [ ] **Step 3: `agentActivityResend.ts` — per-agent function + closing skip**

Rename the loop body into an exported function and keep the loop:

```ts
export function resendAgentActivity(send, store): void {
  for (const [id, agent] of store) {
    // A closing agent's character is gone client-side; its activity returns
    // with undoClose, never with a handshake.
    if (agent.closing) continue;
    resendAgentActivityFor(send, store, id, agent);
  }
}

/** Replay ONE agent's live state (team info → tools → background tools →
 *  waiting → context). Used by the handshake and by undoClose. */
export function resendAgentActivityFor(
  send: (message: Record<string, unknown>) => void,
  store: AgentStateStore,
  id: number,
  agent: AgentState,
): void {
  // ...the existing loop body, unchanged...
}
```

(import `AgentState` type.)

- [ ] **Step 4: `moveSession.ts`**

In `moveRefusalReason`, after the `moveInFlight` line:

```ts
if (agent.closing) return 'This agent is closing; undo the close first.';
```

Add one case to `server/__tests__/moveSession.test.ts` next to the existing refusal cases asserting that string for `closing: { since: 0, railIndex: 0, ptyBacked: false }`.

- [ ] **Step 5: `clientMessageHandler.ts` cases**

Imports: `agentCreatedMessage` from `./agentCreatedMessage.js`; `resendAgentActivityFor` alongside `resendAgentActivity`; `CLOSE_GRACE_MS` from constants.

Replace the `closeAgent` case:

```ts
    case 'closeAgent': {
      // Privileged: it can kill a process and now mutates durable state
      // (Closed list, rail order) — the same bar as restartAgent.
      if (!ctx.privileged) break;
      const id = msg.id as number;
      const agent = store.get(id);
      if (!agent || !runtime) break;
      if (!runtime.ptyHost) {
        // No pty host (VS Code never routes here; tests may): today's
        // immediate dismiss + remove.
        runtime.dismissalTracker.dismiss(agent.jsonlFile);
        runtime.removeAgent(id);
        break;
      }
      // Teammates and spawns live inside their lead and are never closable alone.
      if (agent.leadAgentId !== undefined || agent.spawnToolUseId) break;
      if (agent.moveInFlight) break;
      const seats = adapter?.loadSeats() ?? {};
      const began = runtime.beginClose(id, {
        seatId: seats[String(id)]?.seatId,
        railIndex: store.agentOrder.indexOf(id),
        ptyBacked: agent.ptyBacked === true,
      });
      if (began) store.broadcast({ type: 'agentClosing', id, graceMs: CLOSE_GRACE_MS });
      break;
    }

    case 'undoClose': {
      if (!ctx.privileged || !runtime) break;
      const id = msg.id as number;
      const snapshotSeat = store.get(id)?.closing?.seatId;
      const agent = runtime.undoClose(id);
      if (!agent) break;
      // One agentCreated (the client treats it like a new agent), then the
      // live state the client dropped while the id was closing.
      store.broadcast(agentCreatedMessage(id, agent, { seatId: snapshotSeat, restored: true }));
      resendAgentActivityFor((m) => store.broadcast(m), store, id, agent);
      const exit = runtime.ptyHost?.exitInfo(id);
      if (exit && (exit.code !== 0 || exit.signal !== undefined)) {
        store.broadcast({ type: 'agentCrashed', id, code: exit.code, signal: exit.signal });
      }
      break;
    }

    case 'forgetClosedSession': {
      if (!ctx.privileged || !runtime?.closedSessions) break;
      if (runtime.closedSessions.remove(msg.sessionId as string)) runtime.broadcastClosedSessions();
      break;
    }

    case 'reorderAgents': {
      if (!ctx.privileged) break;
      const raw = Array.isArray(msg.order) ? (msg.order as unknown[]) : [];
      const order = store.reorder(raw.filter((v): v is number => Number.isInteger(v)));
      store.broadcast({ type: 'agentOrder', order });
      break;
    }
```

Check the exact field names the existing `agentCrashed` broadcast uses (grep `'agentCrashed'` in `server/src/pty/ptyManager.ts`) and mirror them.

In `handleWebviewReady`, after `teammateAgents,` in `existingAgentsMsg` add:

```ts
    agentOrder: store.agentOrder,
    closedSessions: runtime?.closedSessions?.summaries() ?? [],
    closingAgents: Object.fromEntries(
      [...store]
        .filter(([, a]) => a.closing)
        .map(([id, a]) => [String(id), Math.max(0, CLOSE_GRACE_MS - (Date.now() - a.closing!.since))]),
    ),
```

- [ ] **Step 6: Fix existing closeAgent tests** (at plan time none exist in `server/__tests__`, so expect a no-op; `server.test.ts` keeps asserting today's `agentCreated` payload unchanged, which together with Task 5's unit test is the spec's "byte-identical" check)

Run `grep -n "closeAgent" server/__tests__/*.test.ts`. Any test sending `closeAgent` through a ctx without `privileged: true` must set it; any asserting immediate removal with a pty host present must either advance fake timers by `CLOSE_GRACE_MS` or use a ctx without a pty host.

- [ ] **Step 7: Run the suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/clientMessageHandler.ts server/src/agentActivityResend.ts server/src/moveSession.ts server/__tests__
git commit -m "feat(server): closeAgent grace window, undoClose, forget, reorderAgents, handshake fields"
```

---

### Task 8: Shared resume spawn + transcript poll helpers

**Files:**

- Create: `server/src/spawnResumedPty.ts`
- Modify: `server/src/launchAgentStandalone.ts:176-232` (extract the poll)
- Modify: `server/src/clientMessageHandler.ts` (restartAgent case uses the helper)
- Test: `server/__tests__/spawnResumedPty.test.ts`

**Interfaces:**

- Produces:

```ts
// spawnResumedPty.ts
export interface ResumeSpawnDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  provider: HookProvider;
  launchCwd?: string;
}
export function spawnResumedPty(agent: AgentState, deps: ResumeSpawnDeps): boolean; // false when no host / no buildLaunchCommand
// launchAgentStandalone.ts
export function startTranscriptPoll(
  id: number,
  agent: AgentState,
  projectDir: string,
  store: AgentStateStore,
  runtime: AgentRuntime,
): void;
```

- [ ] **Step 1: Write the failing test**

`server/__tests__/spawnResumedPty.test.ts` (same scaffolding as Task 7's test: temp HOME, store with FileStateAdapter, fake pty host, runtime with host):

```ts
import { spawnResumedPty } from '../src/spawnResumedPty.js';

describe('spawnResumedPty', () => {
  it('stops the old worker, resumes when the transcript exists, broadcasts agentRestarted', () => {
    const { host, starts, running } = makeFakePtyHost();
    const runtime = new AgentRuntime(store, claudeProvider);
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
    runtime.dispose();
  });

  it('uses --session-id when the transcript is gone and falls back to launchCwd', () => {
    const { host, starts } = makeFakePtyHost();
    const runtime = new AgentRuntime(store, claudeProvider);
    runtime.setPtyHost(host);
    const agent = ptyAgent(1, { jsonlFile: '/nope/sess-1.jsonl', spawnCwd: '/nope' });
    store.set(1, agent);
    spawnResumedPty(agent, { store, runtime, provider: claudeProvider, launchCwd });
    expect(starts[0].opts.args.join(' ')).toContain('--session-id sess-1');
    expect(starts[0].opts.cwd).toBe(launchCwd);
    runtime.dispose();
  });

  it('returns false without a pty host', () => {
    const runtime = new AgentRuntime(store, claudeProvider);
    expect(
      spawnResumedPty(ptyAgent(1), { store, runtime, provider: claudeProvider, launchCwd }),
    ).toBe(false);
    runtime.dispose();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/spawnResumedPty.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/spawnResumedPty.ts`** (the `restartAgent` body moved verbatim)

```ts
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
  // Spawn folder → the transcript's recorded cwd → the CLI's launch folder → home.
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
```

Replace the `restartAgent` case body in `clientMessageHandler.ts` with:

```ts
    case 'restartAgent': {
      if (!ctx.privileged || !runtime || !ctx.provider) break;
      const id = msg.id as number;
      const agent = store.get(id);
      if (!agent?.ptyBacked) break;
      spawnResumedPty(agent, { store, runtime, provider: ctx.provider, launchCwd: ctx.launchCwd });
      break;
    }
```

(remove now-unused imports from the handler: `os`, `dirExists`, `ptyEnvironment`, `PTY_SCROLLBACK_MAX_LINES` if nothing else uses them — `noUnusedLocals` will tell you).

- [ ] **Step 4: Extract the transcript poll in `launchAgentStandalone.ts`**

Move the block from `const createdAt = Date.now();` through `runtime.jsonlPollTimers.set(id, pollTimer);` into:

```ts
/** Wait for a freshly spawned session's transcript to appear, then start
 *  watching it. Also detects a /resume into a different session (adopts the
 *  newest untracked JSONL written after the spawn). Shared with restoreSession,
 *  whose transcript may have been deleted. */
export function startTranscriptPoll(
  id: number,
  agent: AgentState,
  projectDir: string,
  store: AgentStateStore,
  runtime: AgentRuntime,
): void {
  const createdAt = Date.now();
  let pollCount = 0;
  const pollTimer = setInterval(() => {
    // ...moved body, unchanged...
  }, JSONL_POLL_INTERVAL_MS);
  runtime.jsonlPollTimers.set(id, pollTimer);
}
```

and call `startTranscriptPoll(id, agent, projectDir, store, runtime);` where the block was.

- [ ] **Step 5: Run the suite**

Run: `cd server && npm test`
Expected: PASS (`clientMessageHandler.pty.test.ts` restart cases still green; `launchAgentStandalone.test.ts` unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/spawnResumedPty.ts server/src/launchAgentStandalone.ts server/src/clientMessageHandler.ts server/__tests__/spawnResumedPty.test.ts
git commit -m "refactor(server): shared resume-spawn and transcript-poll helpers"
```

---

### Task 9: `restoreSession`

**Files:**

- Modify: `server/src/clientMessageHandler.ts` (new case)
- Test: `server/__tests__/clientMessageHandler.restore.test.ts`

**Interfaces:**

- Consumes `runtime.closedSessions` (Task 6), `spawnResumedPty`, `startTranscriptPoll` (Task 8), `store.set(id, agent, extra)` + `insertInOrder` (Task 4), `startFileWatching`/`assignPaletteIfNeeded` (existing).

- [ ] **Step 1: Write the failing tests**

Same scaffolding as Task 7 (fake timers, temp HOME, fake host, `makeCtx`). `agentCreated` is emitted through the store's `agentAdded` event (httpServer's per-socket closure), not `store.broadcast`, so the test mirrors what the socket does — add to `beforeEach`:

```ts
import { agentCreatedMessage } from '../src/agentCreatedMessage.js';
// ...
store.on('agentAdded', (id, a, extra) => broadcasts.push(agentCreatedMessage(id, a, extra)));
```

Helper that closes an agent and elapses the window:

```ts
function closeAndElapse(ctx: ClientMessageContext, id: number) {
  handleClientMessage({ type: 'closeAgent', id }, send, ctx);
  vi.advanceTimersByTime(CLOSE_GRACE_MS);
}

describe('restoreSession', () => {
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
    });
    expect(starts.at(-1)!.opts.args.join(' ')).toContain('--resume sess-1');
    expect(broadcasts.find((b) => b.type === 'closedSessions')).toEqual({
      type: 'closedSessions',
      sessions: [],
    });
    expect(broadcasts.at(-1)).toEqual({ type: 'agentOrder', order: [newId, 2, 3] });
    expect(store.getAdapter()!.loadSeats()[String(newId)]?.seatId).toBe('chair-3');
    expect(store.get(newId)?.sessionId).toBe('sess-1');
  });

  it('refuses (drops the record, spawns nothing) when the session is live again', () => {
    const { host, starts } = makeFakePtyHost();
    const ctx = makeCtx(host);
    store.set(1, ptyAgent(1));
    closeAndElapse(ctx, 1);
    // Came back from outside: adopted under a new id. agentAdded already dropped the record.
    store.set(
      7,
      createTestAgent({
        id: 7,
        sessionId: 'sess-1',
        jsonlFile: '/test/sess-1.jsonl',
        isExternal: true,
      }),
    );
    const before = starts.length;
    handleClientMessage({ type: 'restoreSession', sessionId: 'sess-1' }, send, ctx);
    expect(starts.length).toBe(before);
    expect(runtime!.closedSessions!.list()).toEqual([]);
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
    handleClientMessage(
      { type: 'restoreSession', sessionId: 'sess-1' },
      send,
      makeCtx(host, false),
    );
    expect(starts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.restore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the case**

```ts
    case 'restoreSession': {
      if (!ctx.privileged || !runtime?.closedSessions || !runtime.ptyHost || !ctx.provider) break;
      const sessionId = msg.sessionId as string;
      const record = runtime.closedSessions.get(sessionId);
      if (!record) break;
      // Live again (adopted from outside, resumed elsewhere): a second --resume
      // would fork the transcript. Drop the record instead.
      const live = [...store.values()].some(
        (a) => a.sessionId === record.sessionId || a.jsonlFile === record.jsonlFile,
      );
      runtime.closedSessions.remove(sessionId);
      runtime.broadcastClosedSessions();
      if (live) break;

      // Never reuse the old id: the webview, the seats file and shadow stores
      // all key on it, and a stale tab may still hold it.
      const id = store.nextAgentId.current++;
      const agent: AgentState = {
        id,
        sessionId: record.sessionId,
        terminalRef: { name: record.terminalName } as vscode.Terminal,
        isExternal: false,
        projectDir: record.projectDir,
        jsonlFile: record.jsonlFile,
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
        palette: record.palette,
        hueShift: record.hueShift,
        ptyBacked: true,
        customTitle: record.customTitle,
        spawnCwd: record.spawnCwd,
        bypassPermissions: record.bypassPermissions,
      };
      assignPaletteIfNeeded(agent, store);
      runtime.knownJsonlFiles.add(record.jsonlFile);
      runtime.registerAgent(agent.sessionId, id);
      store.set(id, agent, { seatId: record.seatId, restored: true });

      let hasTranscript = false;
      try {
        agent.fileOffset = fs.statSync(record.jsonlFile).size;
        hasTranscript = true;
      } catch {
        /* transcript gone: poll for the fresh one below */
      }
      if (hasTranscript) {
        startFileWatching(id, record.jsonlFile, store, runtime.fileWatchers, runtime.pollingTimers, runtime.waitingTimers, runtime.permissionTimers);
      } else {
        startTranscriptPoll(id, agent, record.projectDir, store, runtime);
      }

      // A failed spawn must not throw out of the dispatcher: the record is
      // already gone, so leave the agent as a STOPPED pty (crash glyph +
      // Restart) — the transcript is untouched and the user has a way forward.
      try {
        spawnResumedPty(agent, { store, runtime, provider: ctx.provider, launchCwd: ctx.launchCwd });
      } catch (err) {
        console.error(`[Pixel Agents] Restore of ${sessionId} failed to spawn:`, err);
        runtime.ptyHost.markStopped(id, { code: 1 });
        store.broadcast({ type: 'agentCrashed', id, code: 1 });
      }

      store.insertInOrder(id, record.railIndex);
      store.broadcast({ type: 'agentOrder', order: store.agentOrder });

      if (record.seatId && adapter) {
        const seats = adapter.loadSeats();
        seats[String(id)] = { ...seats[String(id)], palette: agent.palette, hueShift: agent.hueShift, seatId: record.seatId };
        adapter.saveSeats(seats);
      }
      store.persist();
      console.log(`[Pixel Agents] Restored closed session ${sessionId} as agent ${id}`);
      break;
    }
```

Imports needed in the handler: `import type * as vscode from 'vscode';`, `DEFAULT_MAX_CONTEXT_TOKENS` from constants, `startFileWatching` from `./fileWatcher.js`, `assignPaletteIfNeeded` from `./paletteAssigner.js`, `startTranscriptPoll` from `./launchAgentStandalone.js`, `spawnResumedPty`, `AgentState` type.

- [ ] **Step 4: Run the suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/clientMessageHandler.ts server/__tests__/clientMessageHandler.restore.test.ts
git commit -m "feat(server): restoreSession re-spawns a closed session under a new id"
```

---

### Task 10: Webview state — closing filter, toast entries, closed list, rail order

**Files:**

- Create: `webview-ui/src/office/railOrder.ts`
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts`
- Test: `webview-ui/test/railOrder.test.ts`

**Interfaces:**

- Produces `sortByRailOrder(ids: number[], order: number[]): number[]` (pure).
- Produces on `ExtensionMessageState`:

```ts
closingAgents: Record<number, { until: number; graceMs: number }>;
closedSessions: ClosedSessionSummary[];   // type from core/src/messages.js
agentOrder: number[];
```

- [ ] **Step 1: Write the failing unit test**

`webview-ui/test/railOrder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { sortByRailOrder } from '../src/office/railOrder.js';

describe('sortByRailOrder', () => {
  it('follows the order, then unknown ids ascending', () => {
    expect(sortByRailOrder([1, 2, 3, 9, 4], [3, 1])).toEqual([3, 1, 2, 4, 9]);
  });
  it('ignores order entries that are not in ids', () => {
    expect(sortByRailOrder([5, 6], [7, 6, 8])).toEqual([6, 5]);
  });
  it('empty order is ascending id', () => {
    expect(sortByRailOrder([3, 1, 2], [])).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd webview-ui && npx vitest run test/railOrder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `webview-ui/src/office/railOrder.ts`**

```ts
/** Rail order: ids in `order` first (that order), then the rest ascending.
 *  Pure, so the gap between agentCreated and the next agentOrder is stable. */
export function sortByRailOrder(ids: number[], order: number[]): number[] {
  const rank = new Map<number, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const ranked = ids.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const rest = ids.filter((id) => !rank.has(id)).sort((a, b) => a - b);
  return [...ranked, ...rest];
}
```

- [ ] **Step 4: Run the test**

Run: `cd webview-ui && npx vitest run test/railOrder.test.ts`
Expected: PASS.

- [ ] **Step 5: `useExtensionMessages.ts` changes**

(a) Types + state. Import `import type { ClosedSessionSummary, HooksConsentRequest } from '../../../core/src/messages.js';`. Add to `ExtensionMessageState`:

```ts
  /** Agents inside the close grace window: toast entries, keyed by id. */
  closingAgents: Record<number, { until: number; graceMs: number }>;
  /** The Closed list (restorable sessions), newest first. */
  closedSessions: ClosedSessionSummary[];
  /** Rail order from the server; ids not listed sort after it by id. */
  agentOrder: number[];
```

State:

```ts
const [closingAgents, setClosingAgents] = useState<
  Record<number, { until: number; graceMs: number }>
>({});
/** Synchronous mirror of closingAgents' keys for the message filter. */
const closingIdsRef = useRef<Set<number>>(new Set());
const [closedSessions, setClosedSessions] = useState<ClosedSessionSummary[]>([]);
const [agentOrder, setAgentOrder] = useState<number[]>([]);
```

and return all three.

(b) Factor the teardown. Turn the current `agentClosed` branch body into a local function inside the effect:

```ts
// Everything agentClosed drops. keepNames: agentClosing keeps customTitles/
// terminalNames so the undo toast can still label the agent.
const tearDownAgent = (id: number, keepNames: boolean) => {
  setAgents((prev) => prev.filter((a) => a !== id));
  setSelectedAgent((prev) => (prev === id ? null : prev));
  setPtyBackedByAgent((prev) => without(prev, id));
  if (!keepNames) {
    setCustomTitles((prev) => without(prev, id));
    setTerminalNames((prev) => without(prev, id));
  }
  ptyEventBus.remove(id);
  clearMoveTimer(id);
  setTeammateIds((prev) => without(prev, id));
  setMovePending((prev) => without(prev, id));
  setMoveErrors((prev) => without(prev, id));
  setAgentTools((prev) => without(prev, id));
  setAgentStatuses((prev) => without(prev, id));
  setSubagentTools((prev) => without(prev, id));
  delete backgroundParentToolIdsRef.current[id];
  os.removeAllSubagents(id);
  setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id));
  os.removeAgent(id);
};
const markClosing = (id: number, remainingMs: number, graceMs: number) => {
  closingIdsRef.current.add(id);
  setClosingAgents((prev) => ({ ...prev, [id]: { until: Date.now() + remainingMs, graceMs } }));
};
const unmarkClosing = (id: number) => {
  closingIdsRef.current.delete(id);
  setClosingAgents((prev) => without(prev, id));
};
```

(`os` is the handler's local; define these inside `handler` or pass `os` in — keep them inside `handler` right after `const os = getOfficeState();` so they close over it. `without` is the existing helper at line 40.)

Branches:

```ts
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number;
        unmarkClosing(id);
        tearDownAgent(id, false);
      } else if (msg.type === 'agentClosing') {
        const id = msg.id as number;
        const graceMs = msg.graceMs as number;
        tearDownAgent(id, true);
        markClosing(id, graceMs, graceMs);
      } else if (msg.type === 'closedSessions') {
        setClosedSessions((msg.sessions ?? []) as ClosedSessionSummary[]);
      } else if (msg.type === 'agentOrder') {
        setAgentOrder((msg.order ?? []) as number[]);
      }
```

(c) The filter. Right after the `providerCapabilities` early return and BEFORE the pty-event routing:

```ts
// A closing agent's character is gone; everything about it is dropped
// until agentClosed (final) or agentCreated (undo). Several handlers
// write React state unconditionally, so this is explicit.
if (
  typeof msg.id === 'number' &&
  closingIdsRef.current.has(msg.id) &&
  msg.type !== 'agentClosed' &&
  msg.type !== 'agentCreated' &&
  msg.type !== 'agentClosing'
) {
  return;
}
```

(d) `agentCreated`: at the top of the branch add `unmarkClosing(id);` and read `const restored = msg.restored === true; const seatId = msg.seatId as string | undefined;`. In the non-teammate `os.addAgent(...)` call pass `seatId` as the 4th argument (`preferredSeatId`) and `restored` as the 5th (`skipSpawnEffect`); if the branch buffers into `pendingAgents` when the layout is not ready, add `seatId` to that pending entry the same way `existingAgents` does. Guard the focus steal: `if (!isTeammate && !restored) setSelectedAgent(id);`. Also, if the webview normally saves seats after adding (`saveAgentSeats(os)`), keep that: the server wrote the seat under the new id already and the webview's save agrees.

(e) `existingAgents`: read `const closing = (msg.closingAgents ?? {}) as Record<string, number>;` FIRST and filter them out of `incoming` before anything is buffered:

```ts
const closingIds = new Set(Object.keys(closing).map(Number));
const incoming = (msg.agents as number[]).filter((id) => !closingIds.has(id));
for (const [idStr, remaining] of Object.entries(closing)) {
  markClosing(Number(idStr), remaining, Math.max(remaining, 1));
}
```

(customTitles/terminalNames maps from the payload are still applied for every id, including closing ones, so the toast has a label.) Set `setAgentOrder((msg.agentOrder ?? []) as number[])` and `setClosedSessions((msg.closedSessions ?? []) as ClosedSessionSummary[])`. Replace the final `merged.sort((a, b) => a - b)` with just `return merged;` — order now lives in `agentOrder`.

Note for `graceMs` on reload: the countdown bar needs the full window to size itself; the server's `closingAgents` carries only the remainder. Pass `graceMs: remaining` (the bar drains from full over the remainder) — acceptable, documented in the toast.

- [ ] **Step 6: Type-check, lint, webview tests**

Run: `npm run check-types && npm run lint && npm run test:webview`
Expected: PASS. Fix `noUnusedLocals` fallout (e.g. the removed numeric sort).

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/railOrder.ts webview-ui/src/hooks/useExtensionMessages.ts webview-ui/test/railOrder.test.ts
git commit -m "feat(webview): closing filter + toast state, closed list and rail order from the server"
```

---

### Task 11: Undo toast (App level) + App wiring

**Files:**

- Create: `webview-ui/src/components/UndoCloseToast.tsx`
- Modify: `webview-ui/src/App.tsx`
- Modify: `webview-ui/src/constants.ts` (one interval constant)

**Interfaces:**

- Consumes `closingAgents`, `customTitles`, `terminalNames`, `agentOrder` (Task 10), `characterLabel` from `office/engine/characters.js`.
- Produces `UndoCloseToast({ entries, onUndo })` with `entries: Array<{ id: number; label: string; until: number; graceMs: number }>`.
- App gains `handleUndoClose`, `handleRestoreSession`, `handleForgetClosedSession`, `handleReorderAgents` (transport sends) — Task 12 consumes the last three.

- [ ] **Step 1: Constant**

In `webview-ui/src/constants.ts` add (near other UI timing constants):

```ts
/** Undo-toast countdown repaint cadence. */
export const UNDO_TOAST_TICK_MS = 100;
```

- [ ] **Step 2: Component**

`webview-ui/src/components/UndoCloseToast.tsx`:

```tsx
import { useEffect, useState } from 'react';

import { UNDO_TOAST_TICK_MS } from '../constants.js';
import { Button } from './ui/Button.js';

export interface UndoToastEntry {
  id: number;
  label: string;
  /** Epoch ms when the server finalizes the close. */
  until: number;
  /** Full bar length in ms (the remainder after a reload). */
  graceMs: number;
}

interface UndoCloseToastProps {
  entries: UndoToastEntry[];
  onUndo: (id: number) => void;
}

/**
 * One toast per agent inside its close grace window, stacked above the bottom
 * toolbar. Rendered by App (not the terminal band) so closing the last agent
 * cannot unmount the only way to undo it.
 */
export function UndoCloseToast({ entries, onUndo }: UndoCloseToastProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (entries.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), UNDO_TOAST_TICK_MS);
    return () => clearInterval(t);
  }, [entries.length]);
  const live = entries.filter((e) => e.until > now);
  if (live.length === 0) return null;
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 flex flex-col gap-6 z-20"
      style={{ bottom: 72 }}
      data-testid="undo-close-toasts"
      role="status"
      aria-live="polite"
    >
      {live.map((e) => {
        const fraction = Math.max(0, Math.min(1, (e.until - now) / e.graceMs));
        return (
          <div
            key={e.id}
            className="relative flex items-center gap-10 px-10 py-6 bg-bg border-2 border-border text-sm text-text shadow-pixel"
            style={{ borderRadius: 0, minWidth: 260 }}
          >
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              Closed {e.label}
            </span>
            <Button
              size="sm"
              variant="accent"
              onClick={() => onUndo(e.id)}
              aria-label={`Undo closing ${e.label}`}
            >
              Undo
            </Button>
            <div
              className="absolute left-0 bottom-0 h-2 bg-accent"
              style={{ width: `${fraction * 100}%` }}
              aria-hidden="true"
            />
          </div>
        );
      })}
    </div>
  );
}
```

The row is `relative` so the bar can sit absolutely inside it; the shadow is the `shadow-pixel` Tailwind class, never an inline `boxShadow` (see Global Constraints). Check the Tailwind class names used elsewhere (`bg-bg`, `border-border`, `text-text`, `bg-accent`) — they exist in `AgentRail.tsx`/`Button.tsx`; `bottom: 72` must clear the bottom toolbar (measure once in the browser; adjust).

- [ ] **Step 3: App wiring**

In `App.tsx`:

- Destructure `closingAgents, closedSessions, agentOrder` from `useExtensionMessages`.
- `railAgents`: build from `sortByRailOrder(agents, agentOrder)` instead of `agents` (import from `./office/railOrder.js`), add `agentOrder` to the memo deps.
- Handlers:

```ts
const handleUndoClose = useCallback((id: number) => transport.send({ type: 'undoClose', id }), []);
const handleRestoreSession = useCallback(
  (sessionId: string) => transport.send({ type: 'restoreSession', sessionId }),
  [],
);
const handleForgetClosedSession = useCallback(
  (sessionId: string) => transport.send({ type: 'forgetClosedSession', sessionId }),
  [],
);
const handleReorderAgents = useCallback(
  (order: number[]) => transport.send({ type: 'reorderAgents', order }),
  [],
);
```

- Toast entries:

```ts
const undoEntries = useMemo(
  () =>
    Object.entries(closingAgents).map(([idStr, c]) => {
      const id = Number(idStr);
      return {
        id,
        label: characterLabel({
          customTitle: customTitles[id],
          terminalName: terminalNames[id],
          id,
        }),
        until: c.until,
        graceMs: c.graceMs,
      };
    }),
  [closingAgents, customTitles, terminalNames],
);
```

(`characterLabel` is already imported in App for `railAgents`; match its parameter shape.)

- Render, inside the top-level container next to `<BottomToolbar>` (so it overlays the office, not the band):

```tsx
{
  isBrowserRuntime && hasPrivilegedToken && undoEntries.length > 0 && (
    <UndoCloseToast entries={undoEntries} onUndo={handleUndoClose} />
  );
}
```

- [ ] **Step 4: Type-check + lint**

Run: `npm run check-types && npm run lint`
Expected: the only failures are `noUnusedLocals` on `handleRestoreSession`, `handleForgetClosedSession`, `handleReorderAgents` — Task 12 consumes them. **Tasks 11 and 12 MUST land in one commit**: do Task 12 now, re-run this step, then commit.

- [ ] **Step 5: Commit (together with Task 12)**

```bash
git add webview-ui/src/components/UndoCloseToast.tsx webview-ui/src/App.tsx webview-ui/src/constants.ts
git commit -m "feat(webview): undo-close toast at App level"
```

---

### Task 12: Rail — Closed section, drag reorder, Alt+arrows

**Files:**

- Create: `webview-ui/src/components/terminal/relativeTime.ts`
- Modify: `webview-ui/src/components/terminal/AgentRail.tsx`
- Modify: `webview-ui/src/components/terminal/TerminalBand.tsx` (props pass-through)
- Modify: `webview-ui/src/App.tsx` (pass the new props)
- Test: `webview-ui/test/relativeTime.test.ts`

**Interfaces:**

- `AgentRail` new props: `onReorder(order: number[])`, `closedSessions: ClosedSessionSummary[]`, `onRestore(sessionId)`, `onForget(sessionId)`. `TerminalBand` takes the same four and forwards them.
- `relativeTime(fromMs: number, nowMs: number): string` → "just now", "2 min ago", "3 h ago", "2 d ago".

- [ ] **Step 1: relativeTime test + implementation**

`webview-ui/test/relativeTime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { relativeTime } from '../src/components/terminal/relativeTime.js';

describe('relativeTime', () => {
  const now = 1_000_000_000;
  it('buckets', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 120_000, now)).toBe('2 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
});
```

`relativeTime.ts`:

```ts
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse "closed N ago" label for the Closed list. */
export function relativeTime(fromMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - fromMs);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  return `${Math.floor(d / DAY)} d ago`;
}
```

Run: `cd webview-ui && npx vitest run test/relativeTime.test.ts` → PASS.

- [ ] **Step 2: AgentRail**

Props:

```ts
interface AgentRailProps {
  agents: RailAgent[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  onRename: (id: number, customTitle: string) => void;
  /** New top-to-bottom id order after a drag or Alt+arrow. */
  onReorder: (order: number[]) => void;
  closedSessions: ClosedSessionSummary[];
  onRestore: (sessionId: string) => void;
  onForget: (sessionId: string) => void;
  width: number;
}
```

Drag state and helpers inside the component:

```ts
const [dragId, setDragId] = useState<number | null>(null);
const [dropHint, setDropHint] = useState<{ id: number; after: boolean } | null>(null);

const moveTo = (id: number, targetIndex: number) => {
  const ids = agents.map((a) => a.id);
  const from = ids.indexOf(id);
  if (from === -1) return;
  ids.splice(from, 1);
  const at = Math.max(0, Math.min(targetIndex, ids.length));
  ids.splice(at, 0, id);
  onReorder(ids);
};
```

On each agent row add:

```tsx
            draggable
            onDragStart={(e) => {
              setDragId(agent.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropHint(null);
            }}
            onDragOver={(e) => {
              if (dragId === null || dragId === agent.id) return;
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              setDropHint({ id: agent.id, after: e.clientY > box.top + box.height / 2 });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId === null || dropHint?.id !== agent.id) return;
              const ids = agents.map((a) => a.id);
              const base = ids.indexOf(agent.id);
              const fromBefore = ids.indexOf(dragId) < base;
              let target = dropHint.after ? base + 1 : base;
              if (fromBefore) target -= 1;
              moveTo(dragId, target);
              setDragId(null);
              setDropHint(null);
            }}
```

Keyboard, extend the row's `onKeyDown`:

```ts
if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
  e.preventDefault();
  const idx = agents.findIndex((a) => a.id === agent.id);
  moveTo(agent.id, e.key === 'ArrowUp' ? idx - 1 : idx + 1);
  return;
}
```

Insertion line: NOT a box-shadow (the `pixel-shadow` lint rule rejects any inline `boxShadow` but the pixel one, and hiding it in a conditional expression would be circumvention, not compliance). Swap the row's 2 px borders instead: give every row `border-t-2 border-t-transparent` (so nothing jumps) on top of its existing `border-b-2 border-border`, and when `dropHint?.id === agent.id` add `dropHint.after ? 'border-b-accent' : 'border-t-accent'` to the className. Set `draggable={false}` on the ✎ button, the ✕ button, and the rename `<input>`.

Closed section, after the `agents.map(...)` block, inside the rail's root div:

```tsx
{
  closedSessions.length > 0 && (
    <div className="mt-auto border-t-2 border-border" data-testid="closed-sessions">
      <div className="px-6 py-2 text-2xs text-text-muted uppercase">Closed</div>
      {closedSessions.map((s) => {
        const label = s.customTitle || s.terminalName || s.sessionId.slice(0, 8);
        return (
          <div
            key={s.sessionId}
            className="flex items-center gap-4 px-6 py-4 border-b-2 border-border text-2xs opacity-70"
          >
            <span
              className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              title={`closed ${relativeTime(s.closedAt, Date.now())}`}
            >
              {label}
              <span className="text-text-muted"> · {relativeTime(s.closedAt, Date.now())}</span>
            </span>
            <button
              type="button"
              onClick={() => onRestore(s.sessionId)}
              className="bg-transparent border-none cursor-pointer text-2xs text-text-muted hover:text-text px-2"
              title="Restore session"
              aria-label={`Restore ${label}`}
            >
              ↺
            </button>
            <button
              type="button"
              onClick={() => onForget(s.sessionId)}
              className="bg-transparent border-none cursor-pointer text-2xs text-text-muted hover:text-danger px-2"
              title="Forget session"
              aria-label={`Forget ${label}`}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

Import `relativeTime` and `type ClosedSessionSummary` (from `../../../../core/src/messages.js` — count the `..` from `webview-ui/src/components/terminal/`).

- [ ] **Step 3: TerminalBand + App pass-through**

`TerminalBandProps` gains `onReorder`, `closedSessions`, `onRestore`, `onForget`; forward them to `<AgentRail>`. In `App.tsx` pass `onReorder={handleReorderAgents}`, `closedSessions={closedSessions}`, `onRestore={handleRestoreSession}`, `onForget={handleForgetClosedSession}`.

The band's mount condition `railAgents.length > 0` must become `(railAgents.length > 0 || closedSessions.length > 0)` so the Closed list is reachable after the last agent closes; `TerminalBand` already copes with `focused === null` (check the `focused ? … : …` branch renders something sensible; if it renders nothing for the pane, that is fine).

- [ ] **Step 4: Type-check, lint, webview tests**

Run: `npm run check-types && npm run lint && npm run test:webview`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/terminal webview-ui/src/App.tsx webview-ui/test/relativeTime.test.ts
git commit -m "feat(webview): Closed section with restore/forget, drag + Alt-arrow rail reordering"
```

---

### Task 13: Favicon + tab title

**Files:**

- Create: `webview-ui/public/favicon.png` (copy of `icon.png`)
- Modify: `webview-ui/index.html`
- Modify: `webview-ui/src/main.tsx`
- Modify: `e2e/tests/standalone/ui.spec.ts` (one test)

- [ ] **Step 1: Files**

```bash
cp icon.png webview-ui/public/favicon.png
```

`webview-ui/index.html` head:

```html
<meta charset="UTF-8" />
<link rel="icon" type="image/png" href="./favicon.png" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Pixel Agents</title>
```

`main.tsx`, before `createRoot(...)`:

```ts
// Browser tab identity: two daemons on different ports must be telling
// apart at a glance. VS Code webviews have no visible title.
if (isBrowserRuntime) document.title = `Pixel Agents · ${window.location.host}`;
```

- [ ] **Step 2: E2E assertion**

Append to `e2e/tests/standalone/ui.spec.ts` (inside its describe, same fixture):

```ts
test('the tab has a Pixel Agents title and a favicon @area:standalone', async ({
  page,
  standalone,
}) => {
  await expect(page).toHaveTitle(/^Pixel Agents · /);
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href).toContain('favicon.png');
  const res = await page.request.get(new URL(href!, standalone.hostUrl).toString());
  expect(res.status()).toBe(200);
});
```

(Match the `@area:` tag other tests in that file use.)

- [ ] **Step 3: Build + run that test**

Run: `npm run compile && npm run e2e -- --grep "Pixel Agents title"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add webview-ui/public/favicon.png webview-ui/index.html webview-ui/src/main.tsx e2e/tests/standalone/ui.spec.ts
git commit -m "feat(webview): favicon and 'Pixel Agents · host' tab title for the standalone SPA"
```

---

### Task 14: End-to-end spec + inventory

**Files:**

- Create: `e2e/tests/standalone/close-undo-restore.spec.ts`
- Regenerate: `e2e/README.md`

- [ ] **Step 1: Write the spec**

```ts
import fs from 'node:fs';

import { expect, test } from '../../fixtures/standalone';
import { expectOverlayCount } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

const SPAWN_TIMEOUT_MS = 20_000;
// Server-side grace window (CLOSE_GRACE_MS) plus slack.
const GRACE_MS = 10_000;
const AFTER_GRACE_MS = GRACE_MS + 5_000;

async function spawnNamed(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByRole('button', { name: '+ Agent' }).click();
  await expect(page.getByRole('dialog', { name: 'New agent' })).toBeVisible();
  await page.getByLabel('Agent name').fill(name); // the input's aria-label
  await page.getByRole('button', { name: 'Spawn' }).click();
}

function invocationLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test.describe('Standalone / Close, undo, restore', () => {
  test('closing from the rail shows an Undo toast; Undo brings the agent back without a new process @area:terminal', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await spawnNamed(page, 'Keeper');
    await expect(page.getByRole('tab', { name: /Keeper/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(1);

    await page.getByRole('button', { name: 'Close Keeper' }).click();
    const undo = page.getByRole('button', { name: 'Undo closing Keeper' });
    await expect(undo).toBeVisible();
    await expectOverlayCount(page, 0, 5_000);

    await undo.click();
    await expect(undo).toBeHidden();
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);
    await expect(page.getByRole('tab', { name: /Keeper/ })).toBeVisible();
    // Same process: no second mock invocation.
    expect(invocationLines(standalone.mockLogFile)).toHaveLength(1);
  });

  test('a reload inside the window still offers Undo @area:terminal', async ({
    page,
    standalone,
  }) => {
    await spawnNamed(page, 'Reloaded');
    await expect(page.getByRole('tab', { name: /Reloaded/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    // Budget: close → reload → full handshake (every sprite over WS on a
    // throttled CI runner) → Undo click must all fit inside CLOSE_GRACE_MS
    // (10 s). Drain first so the reload is the only work in between.
    await standalone.drainMessages();
    await page.getByRole('button', { name: 'Close Reloaded' }).click();
    await page.reload();
    const undo = page.getByRole('button', { name: 'Undo closing Reloaded' });
    await expect(undo).toBeVisible({ timeout: 8_000 });
    await undo.click();
    await expect(page.getByRole('tab', { name: /Reloaded/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(invocationLines(standalone.mockLogFile)).toHaveLength(1);
  });

  test('after the window the session is on the Closed list; Restore resumes it; Forget drops it @area:terminal', async ({
    page,
    standalone,
  }) => {
    await spawnNamed(page, 'Phoenix');
    await expect(page.getByRole('tab', { name: /Phoenix/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(1);
    const firstSessionId = invocationLines(standalone.mockLogFile)[0].match(/session-id=(\S+)/)![1];

    await page.getByRole('button', { name: 'Close Phoenix' }).click();
    const restore = page.getByRole('button', { name: 'Restore Phoenix' });
    await expect(restore).toBeVisible({ timeout: AFTER_GRACE_MS });
    await expect(page.getByRole('tab')).toHaveCount(0);

    await restore.click();
    await expect(page.getByRole('tab', { name: /Phoenix/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expect(restore).toBeHidden();
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(2);
    expect(invocationLines(standalone.mockLogFile)[1]).toContain(`session-id=${firstSessionId}`);

    // Close again, then Forget.
    await page.getByRole('button', { name: 'Close Phoenix' }).click();
    const forget = page.getByRole('button', { name: 'Forget Phoenix' });
    await expect(forget).toBeVisible({ timeout: AFTER_GRACE_MS });
    await forget.click();
    await expect(page.getByTestId('closed-sessions')).toBeHidden();
  });

  test('Alt+ArrowUp reorders the rail and the order survives a reload @area:terminal', async ({
    page,
  }) => {
    await spawnNamed(page, 'First');
    await expect(page.getByRole('tab', { name: /First/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await spawnNamed(page, 'Second');
    await expect(page.getByRole('tab', { name: /Second/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    const tabs = page.getByRole('tab');
    await expect(tabs.nth(0)).toContainText('First');
    await tabs.nth(1).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(tabs.nth(0)).toContainText('Second');
    await page.reload();
    await expect(page.getByRole('tab').nth(0)).toContainText('Second', {
      timeout: SPAWN_TIMEOUT_MS,
    });
  });
});
```

Check `NewAgentModal.tsx` for the name field's accessible label and the mock's default scenario (whether it writes a JSONL; the restore assertion only relies on `session-id=` which the runner logs for both flags). If the band hides when the second agent's spawn does not auto-open it, assert on the rail only after it is visible.

- [ ] **Step 2: Run it**

Run: `npm run compile && npm run e2e -- --grep "Close, undo, restore"`
Expected: 4 passed. Debug with `npm run e2e:debug -- --grep "..."`.

- [ ] **Step 3: Inventory + commit**

```bash
npm run e2e:inventory
git add e2e/tests/standalone/close-undo-restore.spec.ts e2e/README.md
git commit -m "test(e2e): close → undo / closed list → restore + forget / rail reorder"
```

---

### Task 15: Docs

**Files:**

- Modify: `CLAUDE.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: CLAUDE.md**

- AsyncAPI section: "**44 ServerMessage variants**" (add `agentClosing`, `closedSessions`, `agentOrder` to the lifecycle list) and "**34 ClientMessage variants**" (add `undoClose`, `restoreSession`, `forgetClosedSession`, `reorderAgents` under in-office pty terminals).
- Server Runtime: add a paragraph:

> **Undo close / Closed list / rail order (standalone)**: `closeAgent` is privileged and starts a server-owned grace window (`CLOSE_GRACE_MS`): `AgentState.closing` snapshots the seat, rail index and kind at the click, the pty and watchers keep running, and `agentClosing` tells every tab to tear the character down and show the Undo toast. `undoClose` cancels it and re-announces the agent with one `agentCreated` (`seatId`, `restored`) plus a per-agent activity resend. `finalizeClose` is the ONLY writer of the Closed list (`closedSessions.ts`, capped at `CLOSED_SESSIONS_MAX`, persisted): in-office agents become a `ClosedSession` record and die; adopted sessions are just removed (undo only). `restoreSession` re-spawns under a NEW id through `spawnResumedPty` (shared with `restartAgent`) and re-inserts at the old rail index. Rail order is `AgentStateStore.agentOrder` (top-level ids, persisted with the agents, repaired on every `reorderAgents`). The webview drops every per-agent message for a closing id; `existingAgents.closingAgents` lets a tab that connects mid-window still undo.

- Persistence: `standalone-state.json { agents, seats, closedSessions, agentOrder }`.
- Testing table: add `closedSessions.test.ts`, `agentRuntime.closeGrace.test.ts`, `clientMessageHandler.close.test.ts`, `clientMessageHandler.restore.test.ts`, `spawnResumedPty.test.ts`, `agentCreatedMessage.test.ts` with one-line coverage each. Bump "28 Vitest files" in the tree listing accordingly.
- Office UI: one line that the standalone tab title is `Pixel Agents · <host>` with `favicon.png`.

- [ ] **Step 2: CONTEXT.md**

Add a glossary entry:

> **Closed session** — an in-office agent whose close grace window elapsed. Not an Agent any more (no character, no process), but its transcript and identity (name, folder, seat, rail slot) are kept on the Closed list so it can be restored as a new Agent via `claude --resume`. Adopted sessions and teammates never become closed sessions.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CONTEXT.md
git commit -m "docs: undo close, closed sessions, rail order and tab identity"
```

---

## Self-review notes

- Spec coverage: grace window (T6/T7), filter + toast (T10/T11), reload inside window (T7 handshake + T10 existingAgents + e2e), Closed list + persistence (T2/T3), restore (T8/T9), rail order (T4/T7/T10/T12), favicon/title (T13), docs (T15), privilege gating (T7, `hasPrivilegedToken` gates in T11/T12), move refusal (T7), dispose ordering (T6), dropMatching on adoption (T6).
- Type consistency: `CloseSnapshot` (T1) used by `beginClose` (T6) and the handler (T7); `AgentAddedExtra` (T4) used by `agentCreatedMessage` (T5), `undoClose` (T7) and `restoreSession` (T9); `resendAgentActivityFor` (T7) only; `spawnResumedPty`/`startTranscriptPoll` (T8) consumed by T9; `sortByRailOrder` (T10) by T11.
- Known check-points for the implementer: Modelina's generated name for `ClosedSessionSummary` (T1 step 2); `DismissalTracker` query method name (T6); the exact `agentCrashed` field names (T7); the New-agent form's name label (T14); toast `bottom` offset (T11).
