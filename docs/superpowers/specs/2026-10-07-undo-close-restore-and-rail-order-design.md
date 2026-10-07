# Undo close, restore closed sessions, and rail reordering

**Date:** 2026-10-07
**Status:** Design, spec-reviewed (round 1 findings folded in)
**Surface:** Standalone (browser SPA + daemon). The VS Code adapter is untouched: `PixelAgentsViewProvider` handles `closeAgent` in its own branch and never reaches `handleClientMessage` for it, so nothing below changes its behavior.

## Intent

The user has closed the wrong agent by misclicking the rail's ✕ at least twice. Today `closeAgent` kills the in-office pty immediately, with no confirmation and no undo; the only recovery is `claude --resume` from a shell. Three things fix that:

1. **Undo** — for a short grace window after a close, one click brings the exact live process back, nothing lost.
2. **Restore** — after the window, a closed in-office session stays on a "Closed" list at the bottom of the rail and can be brought back later by resuming its transcript.
3. **Rail order** — agents in the rail can be dragged up and down, and the order sticks.

Success: closing an agent is never destructive in the first ten seconds, never loses the transcript afterwards, and the rail keeps the order the user gave it across reloads and daemon restarts.

## Scope decisions (agreed in brainstorm)

- **In-office terminal agents** (pty-backed) get the full treatment: grace window with undo, then a restore list.
- **Adopted outside sessions** get undo only. Close never kills them; it hides the character for the existing 3-minute dismissal cooldown. Undo clears that dismissal and shows the character again. They never appear in the Closed list.
- **Teammates and sub-agents** cannot be closed on their own (new guard; today's handler has none). A **lead** with live teammates can still be closed: its teammates stay in the office for the window (cosmetic, they idle leaderless), undo re-sends the team info, finalize removes the lead and the existing session-end path removes the teammates as it does for a close today.
- The grace window is **server-owned** (approach A): the store stays the single source of truth, every tab sees the same undo toast, and a reload inside the window can still undo.
- The Closed list holds the **last 10** closed sessions, each individually forgettable with its own ✕.
- A restored agent gets back its **name, folder, bypass flag, palette and seat preference**, and returns to its **old rail position** when that slot still makes sense.
- Rail order is **server-persisted** with the agent list, shared by every tab, drives **only the rail** (never seating), and new agents land at the **bottom**.
- Constants in `server/src/constants.ts`: `CLOSE_GRACE_MS = 10_000`, `CLOSED_SESSIONS_MAX = 10`. The window length reaches the webview on the wire (`graceMs`); no client copy.
- No Cmd/Ctrl+Z shortcut for undo (unrequested, and xterm owns that key while a pane has focus). Alt+↑/↓ for reordering stays because the feature needs a keyboard path and the e2e suite needs a deterministic one.

## Architecture

Everything new sits on existing seams: the `AgentStateStore` persistence shape, `ClientMessageHandler`, the `restartAgent` spawn path, the `existingAgents` handshake, and the rail in `TerminalBand`/`AgentRail`. New server files: `closedSessions.ts` (the list), `agentCreatedMessage.ts` (one payload builder for every `agentCreated` emit). `ClosedSession` lives in `core/src/schemas.ts` beside `PersistedAgent`, because `StateAdapter` (core) must name it and core depends on nothing.

### Server: closing state and the grace window

`AgentState` gains one optional field, a snapshot taken at the click so later state churn cannot change what undo or finalize see:

```ts
/** Set while the agent is inside the close grace window; cleared by undo. */
closing?: {
  since: number;
  /** Persisted seat preference at click time (the webview's next saveAgentSeats drops it). */
  seatId?: string;
  /** Rail position at click time; restore re-inserts here. */
  railIndex: number;
  /** Which branch finalize takes, fixed at click time (a racing move must not flip it). */
  ptyBacked: boolean;
};
```

`clientMessageHandler` `closeAgent` becomes **privileged** (it can kill a process and now mutates durable state, the same bar as `restartAgent`):

0. The grace path is taken only when `runtime.ptyHost` exists. Without one the handler keeps today's immediate dismiss + remove (this matters only for tests; the VS Code provider never routes here).
1. Teammates and sub-agent spawns (`leadAgentId` or `spawnToolUseId` set) → ignore.
2. Already `closing`, or `moveInFlight` → ignore.
3. Snapshot `closing = { since, seatId: adapter.loadSeats()[id]?.seatId, railIndex: store.agentOrder.indexOf(id), ptyBacked: !!agent.ptyBacked }`, broadcast `agentClosing { id, graceMs }`, start a per-agent timer in `AgentRuntime.closeGraceTimers`.
4. Adopted outside session: also `dismissalTracker.dismiss(jsonlFile)` now, as today, so the external scanner does not re-adopt it mid-window.
5. The pty and the JSONL watcher keep running. `moveRefusalReason` gains "agent is closing" so a move cannot start inside the window.

**Per-agent broadcasts during the window** are not suppressed server-side. The webview drops them instead (see Webview): several handlers write React state unconditionally (`agentToolStart` → `setAgentTools`, `agentStatus` → `setAgentStatuses` + the done chime, `agentContextUsage`, `agentRenamed`, `agentTeamInfo`), so "unknown id is a no-op" does not hold and the client must filter explicitly.

`undoClose { id }` (privileged):

- No `closing` → ignore.
- Cancel the timer, clear `closing`, for adopted sessions `dismissalTracker.clearDismissal(jsonlFile)`.
- Broadcast `agentCreatedMessage(agent, { seatId: closing.seatId, restored: true })` (the shared builder, below), then **re-send the agent's live state** through a per-agent `resendAgentActivity(id)` (the per-agent body factored out of today's store loop in the handshake): team info, active tools, waiting/permission status, context usage, and `agentCrashed` when `ptyHost.exitInfo(id)` reports an abnormal exit (the pty may have died inside the window; the client dropped that message because the character was gone). Without this the undone character is bare until its next turn.

**Pty exit inside the window** does not remove the agent: `SessionEnd(reason=exit)` only dismisses the file and removes teammates for a non-external agent, so a crashed in-office agent survives to finalize (and lands in the Closed list, from where restore resumes it).

**Timer expiry** (`finalizeClose(id)` on `AgentRuntime`):

- Agent gone (another path removed it first) → return.
- `closing.ptyBacked`: build the `ClosedSession` record from the agent + snapshot, `closedSessions.push`, `unregisterAgent(sessionId)`, `removeAgent(id)` (kills the pty, emits `agentClosed`, drops the id from `agentOrder`), persist + broadcast `closedSessions`.
- Adopted: `removeAgent(id)` only (the dismissal was already recorded).

`removeAgent` gains one line: it cancels `closeGraceTimers.get(id)`. Other removal paths fire inside the window (external `sessionEnd`, the stale check, teammate removal) and must not leave an armed timer behind. `finalizeClose` is the only writer of the Closed list, so a removal through any other path never lands a record there.

**Daemon shutdown inside the window:** `dispose()` cancels every grace timer and treats each closing in-office agent as closed. Order matters because `removeAgent` skips `store.persist()` while `disposing` is set (a clean shutdown must not wipe the on-disk agent list): dispose first finalizes each closing agent (capture the record, delete it from the store and from `agentOrder`), then calls `store.persist()` once so the saved list omits them, saves the closed list, and only then runs the normal teardown. The next daemon starts with that session in the Closed list rather than restoring it as a stopped agent. Adopted sessions that were closing are simply dropped (their dismissal is in-memory and expires anyway).

### Server: the `agentCreated` builder

`httpServer`'s per-socket `onAgentAdded` closure is today the only place that shapes `agentCreated`, driven by the store's `agentAdded(id, agent)` event with no channel for extras. It moves to `server/src/agentCreatedMessage.ts`:

```ts
export interface AgentCreatedExtra {
  seatId?: string;
  restored?: boolean;
}
export function agentCreatedMessage(agent: AgentState, extra?: AgentCreatedExtra): ServerMessage;
```

- `store.set(id, agent, extra?)` passes `extra` through the `agentAdded` event; the socket closure calls the builder with it. Restore uses this so its single `agentCreated` carries `seatId` + `restored`.
- Undo has no `store.set` (the agent never left the store), so it broadcasts the builder's output through `store.broadcast`. One builder, two call sites, no duplicate emits.

### Server: closed sessions list

`core/src/schemas.ts`:

```ts
export interface ClosedSession {
  /** Stable key for restore/forget. One transcript ↔ one entry. */
  sessionId: string;
  jsonlFile: string;
  projectDir: string;
  terminalName: string;
  customTitle?: string;
  spawnCwd?: string;
  bypassPermissions?: boolean;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  railIndex: number;
  closedAt: number;
}
```

`server/src/closedSessions.ts`, class `ClosedSessions`:

- `push(record)` de-dupes by `sessionId` (newest wins), prepends, trims to `CLOSED_SESSIONS_MAX`. `remove(sessionId)`, `get(sessionId)`, `list()`, `summaries()`.
- `dropMatching(agent)` removes any record whose `sessionId` or `jsonlFile` matches an agent that just appeared in the store (adopted from outside, `--resume`d elsewhere). Wired to the store's `agentAdded` event by `AgentRuntime`, so a record can never describe a session that is already live.
- Persisted under `closedSessions` in `standalone-state.json` through `StateAdapter.loadClosedSessions()` / `saveClosedSessions()`. `FileStateAdapter.AdapterState` gains `closedSessions` and `agentOrder`; `readState` and `writeState` round-trip both (malformed → `[]`), so a `saveSeats` after a `saveClosedSessions` no longer erases it. The VS Code adapter never calls the new methods.
- Loaded in `AgentRuntime.setPtyHost` (the host is injected after construction; the list is meaningless without one).

**On the wire** only a summary travels: `ClosedSessionSummary { sessionId, terminalName, customTitle?, closedAt }`. Paths stay server-side, so `closedSessions` needs no privileged gate and `existingAgents.closedSessions` is sent to every connection.

### Server: restore

`restoreSession { sessionId }` (privileged):

1. Look up the record; missing → ignore. If any store agent already has that `sessionId` or `jsonlFile` (the session came back from outside), drop the record, broadcast `closedSessions`, stop.
2. Remove the record and broadcast `closedSessions` first (a double click cannot spawn twice).
3. Allocate a **new** agent id (`store.nextAgentId.current++`). Ids are never reused: the webview, the seats file and shadow stores key on id, and a stale tab could still hold the old one.
4. Build the `AgentState` the way `restoreExternalAgents` builds a stopped pty agent (`ptyBacked: true`, `terminalRef.name`, `spawnCwd`, `bypassPermissions`, `customTitle`, `palette`, `hueShift`), pre-register the transcript in `knownJsonlFiles`, `registerAgent`, and `store.set(id, agent, { seatId, restored: true })`.
5. Transcript present: file offset at end-of-file, `startFileWatching`. Absent: the 1 s "wait for the transcript" poll factored out of `launchAgentStandalone` (which needs it for the same reason), not a watcher on a missing file.
6. Spawn through `spawnResumedPty(agent, ctx)`, the `restartAgent` body factored into a shared helper (cwd fallback chain, `--resume` when the transcript exists, `agentRestarted` broadcast). `restartAgent` calls the same helper so the two cannot drift.
7. Insert the id into `agentOrder` at `railIndex` clamped to the current length, persist, broadcast `agentOrder`.
8. Write the seat preference into the seats file under the new id so the next handshake agrees with what the webview was just told.

A missing transcript still spawns (a fresh session, exactly what `restartAgent` does today): the user asked for the agent back and an empty terminal beats a silent no-op.

### Server: rail order

`AgentStateStore` gains `agentOrder: number[]`:

- Lists **top-level agent ids only** (no teammates, no spawns) and may contain ids that no longer exist; consumers filter.
- `store.set` of a new top-level agent appends its id if absent. `store.delete` removes it (finalize reads the index from the snapshot before that).
- `persist()` writes `agentOrder` in the same file write as `agents`. The VS Code namespace therefore gains the key too; it is harmless there and cheaper than gating.
- First boot after upgrade: the order is `restoreExternalAgents` insertion order, ascending id, which is what the rail showed before.
- `reorderAgents { order: number[] }` (privileged): keep only ids that are current top-level agents, append any current agent the client omitted (stale client), persist, broadcast `agentOrder { order }`.
- `existingAgents` carries `agentOrder` for every connection.

### Protocol (`core/asyncapi.yaml`)

New ServerMessage variants (all broadcast to every connection):

| Message          | Fields                             |
| ---------------- | ---------------------------------- |
| `agentClosing`   | `id`, `graceMs`                    |
| `closedSessions` | `sessions: ClosedSessionSummary[]` |
| `agentOrder`     | `order: integer[]`                 |

Extended: `agentCreated` gains optional `seatId` (string) and `restored` (boolean). `existingAgents` gains optional `agentOrder`, `closedSessions` (summaries) and `closingAgents` (map of id → remaining ms), the last so a tab that connects inside the window gets the toast and the undo instead of a character that vanishes ten seconds later with no explanation.

New ClientMessage variants, all privileged: `undoClose { id }`, `restoreSession { sessionId }`, `forgetClosedSession { sessionId }`, `reorderAgents { order }`. `closeAgent` becomes privileged. Counts: 41 → 44 server, 30 → 34 client.

Privilege gating stated once: an untokened tab still sees toasts, the Closed list and the order change, but its Undo/Restore/Forget/drag requests are ignored by the server. The band already renders only for privileged tabs; the App-level toast is gated the same way.

### Webview

**State** in `useExtensionMessages`:

- `closingAgents: Record<number, { label: string; until: number }>` — set on `agentClosing` (label captured from the current title/name before the character is removed) and from `existingAgents.closingAgents`; cleared on `agentClosed`, on `agentCreated` for that id (undo), and when `until` passes. A parallel `closingIdsRef` (a Set, read synchronously) backs the message filter.
- `closedSessions: ClosedSessionSummary[]` — from `existingAgents` and `closedSessions`.
- `agentOrder: number[]` — from `existingAgents` and `agentOrder`.

**Message handling:**

- `agentClosing`: run the same teardown as `agentClosed` (sub-agents, tools, statuses, character, drop from `agents`), then add the toast entry. `existingAgents` with `closingAgents` runs the same teardown for those ids right after materializing, and the server's handshake `resendAgentActivity` skips closing agents.
- Every per-agent message (`agentToolStart/Done/Permission`, `agentStatus`, `agentContextUsage`, `agentRenamed`, `agentTeamInfo`, `subagent*`, `pty*`) is dropped when its id is in `closingIdsRef`, except `agentClosed` and `agentCreated`. That is the only filter; the server keeps broadcasting.
- `agentCreated` with `restored: true`: `os.addAgent(id, palette, hueShift, seatId, /*skipSpawnEffect*/ true, folderName)`, no change to `selectedAgent`, clear the toast entry.

**Rail order:** `railAgents` in `App.tsx` sorts by position in `agentOrder`; ids not in the order sort after it in ascending id (covers the instant between `agentCreated` and `agentOrder`). The `existingAgents` handler stops sorting `agents` numerically — that sort was the rail's implicit order and the order now has an owner.

**Components** (`webview-ui/src/components/terminal/`):

- `AgentRail` drag-to-reorder with native HTML5 drag events on agent rows: `draggable`, `onDragStart` stores the dragged id, `onDragOver` picks above/below from the pointer's y against the row midpoint and shows a 2 px accent insertion line, `onDrop` builds the order and calls `onReorder(order)`. The ✎ and ✕ buttons and the rename input set `draggable={false}` (a button inside a draggable row otherwise starts the drag). Keyboard: Alt+↑ / Alt+↓ on a focused row moves it one step.
- `AgentRail` renders a **Closed** section at the bottom only when `closedSessions` is non-empty: a muted "Closed" header, then one row per summary with its label (`customTitle` or `terminalName`), a relative "closed 2 min ago" subtitle, ↺ Restore (`onRestore(sessionId)`) and ✕ Forget (`onForget(sessionId)`). Rows are neither draggable nor tabs.
- New `UndoCloseToast.tsx`, rendered by **`App.tsx`** (not the band: the band unmounts when the last agent closes or the terminal is deselected, which would take the undo with it), gated on `hasPrivilegedToken` and a non-empty `closingAgents`, positioned above the bottom toolbar. One toast per closing agent, stacked: `Closed <label>` + an **Undo** button and a thin countdown bar draining over `graceMs`. Pixel styling per the existing rules (2 px solid border, hard shadow, FS Pixel Sans, no inline colors). Undo sends `undoClose`; the toast leaves on `agentCreated`/`agentClosed` for that id or when the countdown reaches zero.

`App.tsx` wires four new transport sends (`undoClose`, `restoreSession`, `forgetClosedSession`, `reorderAgents`) and passes `closingAgents`, `closedSessions` and the order through.

### Error handling

- Every new handler ignores malformed or unknown ids silently, matching the existing handlers.
- A restore whose spawn throws leaves the record removed and the agent present as a stopped pty (the existing crash glyph + Restart path), so the user still has a way forward and the transcript is untouched.
- The closed list and the order are best-effort persistence: a write failure logs and continues, the in-memory state is still broadcast.
- Rail order repairs itself on every `reorderAgents` and every handshake (filter unknown ids, append missing ones); a corrupted persisted order at worst resets to id order.

### Testing

Server (Vitest, `server/__tests__/`):

- `closedSessions.test.ts` — push/de-dupe/trim/remove/dropMatching; adapter round-trip with malformed values; `saveSeats` after `saveClosedSessions` preserves both keys and `agentOrder`.
- `clientMessageHandler.close.test.ts` — close snapshots seat + rail index + ptyBacked and broadcasts `agentClosing` without stopping the pty; `closeAgent` is ignored for teammates, spawns, closing agents, in-flight moves and unprivileged connections; undo clears the snapshot, emits `agentCreated` with `seatId` + `restored` and re-sends team info / tools / status / crash; a seat save inside the window does not change what undo or finalize see; finalize removes the agent, unregisters the session, appends the record and broadcasts `closedSessions`; adopted sessions dismiss/undismiss and never enter the list; `existingAgents` inside the window carries `closingAgents` and skips the activity resend for them; `moveRefusalReason` refuses a closing agent.
- `clientMessageHandler.restore.test.ts` — restore allocates a fresh id, emits one `agentCreated` carrying `seatId` + `restored`, spawns with `--resume` when the transcript exists and polls for it when absent, removes the record first, refuses when the session is already live, re-inserts at `railIndex`, writes the seat under the new id; restart and restore share `spawnResumedPty`.
- `agentRuntime.closeGrace.test.ts` — `removeAgent` through another path cancels the timer and finalize is a no-op; `dispose()` during the window finalizes the record and omits the agent from the persisted list; an agent adopted for a closed session drops its record.
- `agentStateStore.test.ts` additions — order append on set, removal on delete, `extra` passes through `agentAdded`, `reorderAgents` filter + append, persistence round-trip.
- `server.test.ts` / `httpServerWs.test.ts` additions — `agentCreated` from the shared builder is byte-identical to today's payload when no extra is given.

Webview (Vitest, Node runner): `railOrder.test.ts` for the pure sort helper used by `railAgents`.

E2E (Playwright, `e2e/tests/standalone/`), one new spec `close-undo-restore.spec.ts`:

- close → toast visible, character gone → Undo → character and rail entry back with the same name, and the mock-claude scenario's later activity still shows (process never died).
- close → reload the page inside the window → toast still there → Undo works.
- close → wait past the window → Closed section shows the entry → Restore → new rail entry with the same name, mock-claude invoked with `--resume` (asserted through the mock log).
- Forget removes the entry.
- Alt+↑ moves an entry up and the order survives a page reload.

`e2e/README.md` inventory regenerated via `npm run e2e:inventory`.

### Documentation

CLAUDE.md: protocol variant counts, a short "Undo close / Closed list / rail order" paragraph under Server Runtime, the new persistence keys under Persistence, the new test files in the test table. CONTEXT.md gets a "Closed session" entry.

### Browser tab identity (favicon + title)

Added mid-brainstorm: the standalone tab is indistinguishable from any other tab today (`<title>webview-ui</title>`, a dead `/vite.svg` icon link).

- `webview-ui/public/favicon.png` is a copy of the repo's `icon.png` (128×128). `index.html` links it with a `./favicon.png` href: Vite builds with `base: './'`, so the browser resolves it against the SPA root, and the VS Code provider's href rewrite (which only touches `./` paths) turns it into a harmless webview URI.
- `<title>Pixel Agents</title>` in `index.html`.
- In the browser runtime only, `main.tsx` sets `document.title` to `Pixel Agents · <host>` (e.g. `Pixel Agents · localhost:3100`) so two daemons on different ports are telling apart at a glance. VS Code webviews have no visible title and are left alone.
- Pinned by the standalone e2e `ui.spec.ts`: the page title starts with "Pixel Agents" and the favicon link resolves (HTTP 200).

## Out of scope

- Restoring adopted outside sessions after their process has exited.
- Undo for teammates or sub-agents.
- A confirmation dialog on close (the undo replaces it).
- A keyboard shortcut for undo.
- Reordering characters in the office or any seat effect of rail order.
- The VS Code adapter.
