# Undo close, restore closed sessions, and rail reordering

**Date:** 2026-10-07
**Status:** Design, pending spec review
**Surface:** Standalone (browser SPA + daemon). The VS Code adapter is untouched: it has no pty host, so the close path there keeps today's behavior.

## Intent

The user has closed the wrong agent by misclicking the rail's ✕ at least twice. Today `closeAgent` kills the in-office pty immediately, with no confirmation and no undo; the only recovery is `claude --resume` from a shell. Three things fix that:

1. **Undo** — for a short grace window after a close, one click brings the exact live process back, nothing lost.
2. **Restore** — after the window, a closed in-office session stays on a "Closed" list at the bottom of the rail and can be brought back later by resuming its transcript.
3. **Rail order** — agents in the rail can be dragged up and down, and the order sticks.

Success: closing an agent is never destructive in the first ten seconds, never loses the transcript afterwards, and the rail keeps the order the user gave it across reloads and daemon restarts.

## Scope decisions (agreed in brainstorm)

- **In-office terminal agents** (pty-backed) get the full treatment: grace window with undo, then a restore list.
- **Adopted outside sessions** get undo only. Close never kills them; it hides the character for the existing 3-minute dismissal cooldown. Undo clears that dismissal and shows the character again. They never appear in the Closed list.
- **Teammates and sub-agents** are out of scope. They live inside their lead's process and are not closable on their own.
- The grace window is **server-owned** (approach A): the store stays the single source of truth, every tab sees the same undo toast, and a reload inside the window can still undo.
- The Closed list holds the **last 10** closed sessions, each individually forgettable with its own ✕.
- A restored agent gets back its **name, folder, bypass flag, palette and seat preference**, and returns to its **old rail position** when that slot still makes sense (see Rail order).
- Rail order is **server-persisted** with the agent list, shared by every tab, drives **only the rail** (never seating), and new agents land at the **bottom**.
- Defaults: `CLOSE_GRACE_MS = 10_000`, `CLOSED_SESSIONS_MAX = 10`.

## Architecture

Everything new sits on existing seams: the `AgentStateStore` persistence shape, `ClientMessageHandler`, the `restartAgent` spawn path, the `existingAgents` handshake, and the rail in `TerminalBand`/`AgentRail`. No new module boundaries beyond one server file (`closedSessions.ts`) that owns the closed list.

### Server: closing state and the grace window

`AgentState` gains one optional field:

```ts
/** Set while the agent is inside the close grace window; cleared by undo. */
closingSince?: number;
```

`clientMessageHandler` `closeAgent` (privileged only — a close now mutates durable state and can kill a process, same bar as `restartAgent`; the existing handler had no gate, this adds one):

0. The grace path is taken only when `runtime.ptyHost` exists (standalone). Without one (VS Code adapter) the handler keeps today's immediate dismiss + remove, so the extension's behavior is unchanged.
1. If the agent is a teammate or sub-agent spawn (`leadAgentId`/`spawnToolUseId` set) → ignore, as today.
2. If `closingSince` is already set → ignore (double click).
3. Set `closingSince = Date.now()`, broadcast `agentClosing { id, graceMs }`, and start a per-agent timer in a new `AgentRuntime` map (`closeGraceTimers`).
4. **Adopted outside session** (not `ptyBacked`): also `dismissalTracker.dismiss(jsonlFile)` now, as today, so the external scanner doesn't re-adopt it mid-window.
5. Nothing else changes: the pty keeps running, the JSONL watcher keeps running, tool/status broadcasts keep flowing (the webview ignores them for a closing agent; see below).

`undoClose { id }` (privileged):

- If no `closingSince` → ignore.
- Cancel the timer, clear `closingSince`, for adopted sessions `dismissalTracker.clearDismissal(jsonlFile)`, then broadcast a **full `agentCreated`** for the agent (same payload `httpServer.onAgentAdded` emits, plus `seatId` from the persisted seats). The webview treats this exactly like a new agent appearing, so no new "re-add" path is needed client-side. The payload also carries `restored: true` so the webview skips the spawn effect and does not steal focus.

Timer expiry (`finalizeClose(id)` on `AgentRuntime`):

- In-office agent: capture a `ClosedSession` record (below), `removeAgent(id)` (kills the pty and emits `agentClosed`), then persist the closed list and broadcast `closedSessions`.
- Adopted session: `removeAgent(id)` only (the dismissal was already recorded).

`removeAgent` itself does not change. `finalizeClose` is the only caller that adds to the closed list, so a close triggered by other paths (session end, `/clear` reassignment, teammate removal) never lands a record there.

**Daemon shutdown inside the window:** `dispose()` cancels every grace timer and treats each closing in-office agent as closed. Order matters because `removeAgent` skips `store.persist()` while `disposing` is set (a clean shutdown must not wipe the on-disk agent list): dispose first finalizes each closing agent (capture the record, delete it from the store and from `agentOrder`), then calls `store.persist()` once so the saved list omits them, saves the closed list, and only then runs the normal teardown. The next daemon starts with that session in the Closed list rather than restoring it as a stopped agent. Adopted sessions that were closing are simply dropped (their dismissal is in-memory and expires anyway).

**Status broadcasts during the window:** the server does not suppress them. The webview removes the character and rail entry on `agentClosing`, and every per-agent message for an unknown id is already a no-op client-side (`os.setAgentTool` etc. look the character up and bail). This keeps the server path small and mirrors how a brand-new tab ignores messages for agents it hasn't materialized yet.

### Server: closed sessions list

New file `server/src/closedSessions.ts` with a tiny class `ClosedSessions`:

```ts
export interface ClosedSession {
  /** Stable key for restore/forget. Equals the session id (one transcript ↔ one entry). */
  sessionId: string;
  jsonlFile: string;
  projectDir: string;
  customTitle?: string;
  terminalName: string;
  spawnCwd?: string;
  bypassPermissions?: boolean;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  /** Rail index at close time; restore re-inserts here when still in range. */
  railIndex: number;
  closedAt: number;
}
```

- `push(record)` — de-dupes by `sessionId` (closing the same session twice keeps the newest record), prepends, trims to `CLOSED_SESSIONS_MAX`.
- `remove(sessionId)`, `list()`.
- Persisted under `closedSessions` in `standalone-state.json` through a new pair on `StateAdapter`: `loadClosedSessions()` / `saveClosedSessions()`. `FileStateAdapter` adds the key beside `agents` and `seats`; unknown or malformed values load as `[]`. The VS Code adapter never writes it.
- Loaded once in `AgentRuntime` construction when a pty host is present; broadcast as part of the handshake (`closedSessions` field on `existingAgents`, privileged only, like `crashedAgentIds`) and after every change (`closedSessions` broadcast, privileged-only delivery).

The seat comes from `adapter.loadSeats()[id]?.seatId` at capture time, before the webview's next `saveAgentSeats` (which no longer lists the removed character) can drop it.

### Server: restore

`restoreSession { sessionId }` (privileged):

1. Look up the record; ignore if missing. Remove it from the list and broadcast `closedSessions` (so a double click can't spawn twice).
2. Allocate a **new** agent id (`store.nextAgentId.current++`). Ids are never reused: the webview, seats file and shadow stores all key on id and a reused id could collide with a stale entry in a tab that missed the close.
3. Build the `AgentState` the way `restoreExternalAgents` builds a stopped pty agent (`ptyBacked: true`, `terminalRef.name`, `spawnCwd`, `bypassPermissions`, `customTitle`, `palette`, `hueShift`), set the file offset to end-of-file, start file watching, register the session, add to the store (emits `agentCreated`; the emit site adds `seatId` from the record, `restored: true`).
4. Spawn through the same code `restartAgent` uses, factored into a shared helper `spawnResumedPty(agent, ctx)` (cwd fallback chain, `--resume` when the transcript exists, `agentRestarted` broadcast). `restartAgent` calls the same helper so the two paths cannot drift.
5. Insert the new id into the rail order at `railIndex` (clamped to the current length) and broadcast `agentOrder`.
6. Write the seat preference back into the seats file under the new id so the next handshake agrees with what the webview was told.

If the transcript file no longer exists, restore still spawns (a fresh session with `--session-id`, exactly what `restartAgent` does today); the user asked for the agent back and an empty terminal beats a silent no-op.

### Server: rail order

`AgentStateStore` gains `agentOrder: number[]`, persisted as a top-level `agentOrder` key in `standalone-state.json` (same adapter file, new `loadAgentOrder()`/`saveAgentOrder()` pair). Rules:

- Order lists **top-level agent ids only** (no teammates, no spawns) and may contain ids that no longer exist; consumers filter.
- `store.set` of a new top-level agent appends its id if absent. `store.delete` removes it (a finalized close remembers its index in the `ClosedSession` record before deletion).
- `reorderAgents { order: number[] }` (privileged): the server keeps only ids that are current top-level agents, appends any current agent the client omitted (stale client), persists, broadcasts `agentOrder { order }`.
- `existingAgents` carries `agentOrder` (all connections; it is not sensitive).

### Protocol (`core/asyncapi.yaml`)

New ServerMessage variants:

| Message          | Fields                      | Delivery                        |
| ---------------- | --------------------------- | ------------------------------- |
| `agentClosing`   | `id`, `graceMs`             | broadcast                       |
| `closedSessions` | `sessions: ClosedSession[]` | privileged only (carries paths) |
| `agentOrder`     | `order: integer[]`          | broadcast                       |

Extended: `agentCreated` gains optional `seatId` (string) and `restored` (boolean). `existingAgents` gains optional `closedSessions` (privileged only) and `agentOrder`.

New ClientMessage variants, all privileged: `undoClose { id }`, `restoreSession { sessionId }`, `forgetClosedSession { sessionId }`, `reorderAgents { order }`.

`closeAgent` becomes privileged (previously ungated). Variant counts in CLAUDE.md go 41 → 44 server, 30 → 34 client.

`httpServer`'s privileged-delivery gate (`PRIVILEGED_ONLY_TYPES`, `agentCrashed`, `crashAcknowledged`) adds `closedSessions`.

### Webview

**State** in `useExtensionMessages`:

- `closingAgents: Record<number, { label: string; until: number }>` — set on `agentClosing` (label captured from the current rail label before the character is removed), cleared on `agentClosed`, on `agentCreated` for that id (undo), and when `until` passes.
- `closedSessions: ClosedSession[]` — from `existingAgents` and `closedSessions`.
- `agentOrder: number[]` — from `existingAgents` and `agentOrder`.

On `agentClosing` the webview runs the same teardown as `agentClosed` (remove sub-agents, tools, character, drop from `agents`), then records the toast entry. On `agentCreated` with `restored: true` it calls `os.addAgent(id, palette, hueShift, seatId, /*skipSpawnEffect*/ true, ...)` and does not change `selectedAgent`. On `agentCreated` for an id that is still in `closingAgents` it clears the toast entry.

**Rail order:** `railAgents` in `App.tsx` sorts by position in `agentOrder`; ids missing from the order sort after it in ascending id order (covers the moment between `agentCreated` and `agentOrder` arriving). The `existingAgents` handler stops sorting `agents` numerically — that sort was the rail's implicit order and it now belongs to `agentOrder`.

**Components** (all in `webview-ui/src/components/terminal/`):

- `AgentRail` gains drag-to-reorder using native HTML5 drag events on the in-office and adopted entries (no library): `draggable`, `onDragStart` stores the dragged id, `onDragOver` on each row computes above/below from the pointer's y relative to the row midpoint and shows a 2 px accent insertion line, `onDrop` builds the new order and calls `onReorder(order)`. Keyboard alternative: Alt+↑ / Alt+↓ on a focused row move it one step (so the feature works without a mouse, which the e2e suite also needs). The ✎ and ✕ buttons stop drag propagation so they keep working.
- `AgentRail` renders a **Closed** section at the bottom, only when `closedSessions` is non-empty: a muted "Closed" header, then one row per record with its label, a relative "closed 2 min ago" subtitle, a ↺ Restore button (`onRestore(sessionId)`) and a ✕ Forget button (`onForget(sessionId)`). Rows are not draggable and not focusable as tabs.
- New `UndoCloseToast.tsx` rendered by `TerminalBand` above the rail/pane row (it belongs to the band, not the office canvas, so it is visible wherever the rail is). One toast per closing agent, stacked: `Closed <label>` + an **Undo** button, with a thin countdown bar that drains over `graceMs`. Pixel styling per the existing rules (`2px solid` border, hard shadow, FS Pixel Sans, no inline colors). Clicking Undo sends `undoClose`; the toast disappears on `agentCreated`/`agentClosed` for that id or when the countdown reaches zero. **Cmd/Ctrl+Z** undoes the most recent close when the layout editor is **not** in edit mode (edit mode keeps its own undo). The toast hook registers its own keydown listener gated on `!isEditMode`; the plan must confirm that `useEditorKeyboard` ignores the shortcut outside edit mode so the two never both fire, and skip the shortcut while focus is inside a terminal pane or text input (xterm consumes Ctrl+Z as a terminal keystroke).

`App.tsx` wires four new transport sends (`undoClose`, `restoreSession`, `forgetClosedSession`, `reorderAgents`) and passes `closingAgents`, `closedSessions` and the order through to the band.

### Error handling

- Every new handler ignores malformed or unknown ids silently, matching the existing handlers.
- A restore whose pty spawn throws leaves the record removed and the agent present as a stopped pty (the existing crash glyph + Restart path), so the user still has a way forward; nothing is lost because the transcript is untouched.
- The closed list is best-effort persistence: a write failure logs and continues, the in-memory list is still broadcast.
- Rail order repairs itself on every `reorderAgents` and every handshake (filter unknown ids, append missing ones); a corrupted persisted order can at worst reset to id order.

### Testing

Server (Vitest, `server/__tests__/`):

- `closedSessions.test.ts` — push/de-dupe/trim/remove; adapter round-trip with malformed values.
- `clientMessageHandler.close.test.ts` — close sets `closingSince` and broadcasts `agentClosing` without stopping the pty; undo clears it and emits `agentCreated` with `seatId` + `restored`; timer expiry removes the agent, appends the record (with the seat read from the adapter and the rail index) and broadcasts `closedSessions`; adopted sessions dismiss/undismiss and never enter the list; double close and undo on a non-closing agent are no-ops; unprivileged connections are ignored for all five messages.
- `clientMessageHandler.restore.test.ts` — restore allocates a fresh id, spawns with `--resume` when the transcript exists, removes the record first, re-inserts at `railIndex`, writes the seat under the new id; restart and restore share the spawn helper (one test spies on it).
- `agentRuntime.closeGrace.test.ts` — `dispose()` during the window finalizes the record and omits the agent from the persisted list.
- `agentStateStore.test.ts` additions — order append on set, removal on delete, `reorderAgents` filter + append semantics, persistence round-trip.
- `httpServerWs.test.ts` addition — `closedSessions` is withheld from unprivileged sockets.

Webview (Vitest, Node runner): `railOrder.test.ts` for the pure sort helper used by `railAgents`.

E2E (Playwright, `e2e/tests/standalone/`): one new spec `close-undo-restore.spec.ts` on the standalone fixture:

- close → toast visible, character gone → Undo → character and rail entry back, same name, terminal still live (mock-claude scenario keeps writing after the undo and the activity shows).
- close → wait past the window → Closed section shows the entry → Restore → new rail entry with the same name, terminal pane shows a resumed session (mock-claude is invoked with `--resume`, asserted through the mock log).
- Forget removes the entry.
- Reorder via Alt+↑ moves an entry up and the order survives a page reload.

`e2e/README.md` inventory regenerated via `npm run e2e:inventory`.

### Documentation

CLAUDE.md: protocol variant counts, a short "Undo close / Closed list / rail order" paragraph under Server Runtime, the new persistence keys under Persistence, and the new test files in the test table. CONTEXT.md gets a "Closed session" entry.

## Out of scope

- Restoring adopted outside sessions after their process has exited.
- Undo for teammates or sub-agents.
- A confirmation dialog on close (the undo replaces it).
- Reordering characters in the office or any seat effect of rail order.
- The VS Code adapter (no pty host; `closeAgent` there keeps today's immediate behavior).
