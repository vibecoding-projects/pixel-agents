# Adopted terminals and claimed seats — design

Date: 2026-09-29. Adapter: standalone only (the VS Code adapter is untouched). Status: approved in conversation; this document is the design of record.

## Why

Watch All Sessions adopts every Claude session that touches its transcript, from any folder. That is wanted: the office should be the one place to see every session instead of hunting through VS Code windows. But adopted agents are second-class in the standalone office today, and the way seats are owned makes the office look broken as soon as there are more agents than computers.

Observed on a real office (six computer seats, eight sofa seats, eight agents):

1. An agent launched from the office sat down to work on a sofa while computer chairs stood empty. The chairs were _owned_ by idle agents that had wandered off; ownership is for life, so the seats were blocked without being used.
2. An agent typed in mid-air on the floor. Every seat, sofas included, was assigned (idle wanderers claim sofa seats on top of the computer seat they own), so `findFreeSeat` returned null and a seatless active character types wherever it stands.
3. Adopted sessions cannot be driven from the office: no rail entry, nothing happens on click, no name. Rename after launch does not exist for any agent.
4. The terminal band forgets its size when hidden and shown again.

## Goals

- Clicking an adopted agent moves its session into the office: the process in the outside terminal is closed, the same session is resumed in an in-office pty, the character keeps its identity and seat. No confirmation step (the user's explicit decision: "the sessions already live here").
- Adopted agents appear in the terminal rail and can be renamed and dismissed. Rename works for every agent, after launch.
- Computer seats are claimed while an agent needs one and released when it walks away, the way sofa seats already work. Roaming and the five-minute desk-hold are unchanged.
- No character ever types with no seat.
- The band keeps its size across hide/show.

## Non-goals

- Restoring moved (or launched) pty agents after a daemon restart. Today launched agents are not restored either; a moved session becomes an ordinary transcript on disk and is re-adopted by the scanner the next time it is active.
- Any change to adoption itself (Watch All Sessions, the 10-minute activity window, dismissal).
- Rest-seat behaviour, wander timing, pets, sub-agents.
- VS Code adapter.

## Vocabulary (CONTEXT.md)

An agent adopted from outside is an **agent** with a **headless** character in VS Code, but in standalone it renders as a normal character (standalone has no ghosts). Moving its session in-office is "attaching a terminal" in code; user-facing copy says "move here". "Adopt" keeps its meaning (begin tracking a session) and is not reused for the terminal step.

---

## Part A — Terminal band size persistence

`TerminalBand` is unmounted when `terminalOpen` is false (`App.tsx`), so its `height`/`width` `useState` defaults reset on every show. The rail width already persists through `loadRailWidth`/`saveRailWidth` in `panelPosition.ts`.

Change:

- `panelPosition.ts`: add `loadBandHeight`/`saveBandHeight` and `loadBandWidth`/`saveBandWidth`, localStorage keys `pixel-agents.terminalBandHeight` / `pixel-agents.terminalBandWidth`, clamped to the existing `TERMINAL_BAND_{MIN,MAX}_{HEIGHT,WIDTH}_PX`, defaulting to `TERMINAL_BAND_DEFAULT_*`. Same try/catch guards as the rail width.
- `TerminalBand.tsx`: seed `useState` from the loaders; save on pointer-up of the edge handle (mirrors the rail divider's pointer-up save). Height and width are independent because bottom docks drag height and side docks drag width.

Tests: `webview-ui/test/panel-position.test.ts` gains cases for default, round-trip, clamp, and garbage values, for both dimensions.

---

## Part B — Moving an adopted session in-office

### Facts the design rests on (verified 2026-09-29)

- Claude Code writes `~/.claude/sessions/<pid>.json` for every interactive session: `{ pid, sessionId, cwd, procStart, version, kind, status, ... }`, and removes it on exit.
- A terminate signal makes an interactive Claude exit within ~1 s; it fires a `SessionEnd` hook with `reason: "other"` on the way out.
- `claude --session-id <existing>` is refused: `Error: Session ID … is already in use.` `claude --resume <id>` continues the session and keeps its id, from the original folder or any other folder; the transcript file stays the same.
- Consequently the existing Restart button (which relaunches with `--session-id`) fails once a transcript exists. It is fixed as part of this work.

### Protocol (`core/asyncapi.yaml`)

New ClientMessage `attachTerminal { id }` — privileged only.

New ClientMessage `renameAgent { id, customTitle }` — privileged only (Part C).

New ServerMessage `agentTerminalAttached { id, terminalName }` — broadcast. The webview marks the agent pty-backed, records the terminal name, and opens the band on it.

New ServerMessage `agentTerminalAttachFailed { id, reason }` — point-to-point to the requester, mirroring `launchAgentFailed`. The webview shows `reason` in the band pane for that agent.

`core/src/provider.ts`:

- `buildLaunchCommand(sessionId, cwd, opts?)` gains `opts.resume?: boolean`. Claude: `['--resume', sessionId]` instead of `['--session-id', sessionId]`.
- New optional `findLiveProcess?(sessionId): Promise<LiveProcess | null>` with `LiveProcess = { pid: number; cwd?: string }`. Claude implementation reads `~/.claude/sessions/*.json`, returns the entry whose `sessionId` matches and whose `pid` is alive (`process.kill(pid, 0)`), else null. A registry entry is Claude's own claim and is removed on exit, so no start-time comparison is attempted; the alive check is the guard against a stale file.
- New optional `transcriptCwd?(jsonlFile): string | undefined` — Claude: the `cwd` field of the most recent record that carries one (read the tail of the file, same partial-line tolerant reading the file watcher uses). Used when no live process is found.

### Server: `server/src/attachTerminal.ts`

`attachTerminal(id, deps): Promise<void>` where deps mirrors `launchAgentStandalone`'s (`store`, `runtime`, `provider`, `launchCwd`) plus `send` for the point-to-point failure. Steps, in order; any failure sends `agentTerminalAttachFailed` and leaves the agent exactly as it was:

1. **Guards.** Agent exists, `isExternal`, not `ptyBacked`, has `sessionId`, `jsonlFile` exists on disk, pty host present, provider has `buildLaunchCommand`. Concurrent attach on the same id is refused while one is in flight (`agent.attachInFlight`, runtime-only).
2. **Locate.** `live = await provider.findLiveProcess?.(sessionId)`. `cwd = live?.cwd ?? provider.transcriptCwd?.(jsonlFile) ?? launchCwd`; if `cwd` does not exist on disk, fall back to `launchCwd`.
3. **Handoff latch.** `agent.pendingHandoff = true` (runtime-only). `hookEventHandler.handleSessionEnd` checks it first: when set, clear it, `markAgentWaiting`, and return without calling `onSessionEnd`. That is what stops the outgoing process's `SessionEnd(reason=other)` from removing the character. The latch also has a safety timeout (`ATTACH_HANDOFF_GRACE_MS`, 10 s): if no `SessionEnd` arrives it is simply cleared.
4. **Stop the outside process** when `live` is non-null: `SIGTERM`, poll every 100 ms for up to `ATTACH_TERMINATE_TIMEOUT_MS` (5 s), then `SIGKILL` and poll up to 2 s more. Still alive → failure ("could not stop the process in the other terminal") and the latch is cleared. When `live` is null the session has no running process (its terminal was already closed) and we resume without stopping anything.
5. **Spawn.** `provider.buildLaunchCommand(sessionId, cwd, { resume: true })`, then `ptyHost.start(id, …)` with the same shell/args/env/size as `launchAgentStandalone`. Terminal name: `Claude Code #<nextTerminalIndex>`.
6. **Flip.** `isExternal = false`, `ptyBacked = true`, `spawnCwd = cwd`, `terminalRef = { name }`, `hookDelivered` unchanged. `store.set` (persist). Broadcast `agentTerminalAttached`. The file watcher keeps following the same transcript; the resumed process's `SessionStart(source=resume)` resolves to the same registered session and takes the "known agent" path.

`clientMessageHandler`: `attachTerminal` case → privileged gate → `attachTerminal(...)`. `restartAgent` passes `resume: fs.existsSync(agent.jsonlFile)` so a restart of any pty agent with a transcript uses `--resume`.

`agentRuntime` `onSessionEnd`: unchanged. Because the agent is no longer external after step 6, a later pty exit surfaces as a crash with the Restart affordance, like a launched agent.

Constants: `ATTACH_TERMINATE_TIMEOUT_MS`, `ATTACH_KILL_TIMEOUT_MS`, `ATTACH_HANDOFF_GRACE_MS`, `ATTACH_POLL_INTERVAL_MS` in `server/src/constants.ts`.

### Webview

- `App.tsx` `handleClick`: for a top-level agent that is not pty-backed, in the browser runtime with a privileged token, send `attachTerminal { id }` and remember `attachPending[id]` so a second click while in flight does nothing. `handleSelectionChange` opens the band for pty-backed agents as today; on `agentTerminalAttached` the band opens on that agent.
- `useExtensionMessages`: `agentTerminalAttached` sets `ptyBackedByAgent[id] = true`, `terminalNames[id]`, clears `attachPending`/`attachErrors`; `agentTerminalAttachFailed` sets `attachErrors[id] = reason`.
- Rail (`railAgents`): every agent that is not a sub-agent and not a teammate (`isTeammate`/`parentAgentId` on `agentCreated`); teammates stay out because clicking one reaches its lead. Non-pty entries render muted with a small "outside" marker; clicking one sends `attachTerminal`. The pane for a non-pty focused agent shows a placeholder: "Moving this session here…" while pending, the failure reason when failed, or "Click to move this session into the office" otherwise.
- Selection of a non-pty agent no longer leaves the band untouched: it opens the band focused on that agent (showing the placeholder), so the move is visible.

### Failure modes

| Situation                                             | Outcome                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Transcript missing                                    | Refused before anything is killed.                                                                                               |
| Registry names a pid that is dead                     | Treated as no live process; resume proceeds.                                                                                     |
| Process ignores SIGTERM and SIGKILL                   | Failure reported; agent stays external; latch cleared.                                                                           |
| Claude refuses the resume (e.g. transcript corrupted) | The pty exits immediately; the agent is now pty-backed and shows the crash + Restart affordance with Claude's error in the pane. |
| The registry entry's `cwd` no longer exists           | Falls back to the transcript cwd, then the CLI's launch cwd.                                                                     |

### Tests (server, Vitest)

- `attachTerminal.test.ts`: guards; kill sequence with a fake `findLiveProcess` and injected `kill`/`isAlive` functions (no real signals); handoff latch set before kill and cleared on SessionEnd or timeout; flip + broadcast; point-to-point failure; concurrent-attach refusal; cwd fallback order.
- `hookEventHandler.test.ts`: `SessionEnd` on an agent with `pendingHandoff` does not call `onSessionEnd` and clears the latch.
- `clientMessageHandler.pty.test.ts`: `attachTerminal` privileged/unprivileged; `restartAgent` uses `--resume` when the transcript exists and `--session-id` when it does not.
- `claude.test.ts`: `buildLaunchCommand` resume flag; `findLiveProcess` against a temp registry directory (alive vs dead pid, no match); `transcriptCwd`.

No e2e: the standalone e2e fixture has no outside Claude process to stop. The unit seam (`findLiveProcess`, injected kill) is where the risk is, and it is covered.

---

## Part C — Rename after launch

Server: `renameAgent { id, customTitle }` (privileged). Trim; empty string clears the title (`customTitle = undefined`). Persist (`customTitle` is already in the persisted shape for every agent, external included). Broadcast `agentRenamed { id, customTitle }` with the trimmed value or `''` when cleared; the webview deletes the entry on `''`. Max length 80 characters (`AGENT_TITLE_MAX_LEN`), silently truncated.

Webview: the rail entry gets a pencil button (same treatment as ✕). Clicking it swaps the label for an inline `<input>` seeded with the current label; Enter commits (`renameAgent`), Escape cancels, blur commits. The nameplate and overlay already render `customTitles`, so nothing else changes.

Tests: `clientMessageHandler.test.ts` — set, clear, trim, truncate, unprivileged no-op, persistence.

---

## Part D — Claimed work seats

### Model

`Character` today: `seatId` (owned for life), `restSeatId` (transient claim). New model:

- `preferredSeatId: string | null` — the seat the user assigned by clicking, or the seat the agent was given when it spawned. Persisted (as `seatId` in `saveAgentSeats`, unchanged wire shape). Never blocks anything by itself.
- `seatId: string | null` — the work (or fallback) seat the character currently **claims**. Claiming sets `seat.assigned = true`; releasing clears it. Transient like `restSeatId`.
- `restSeatId` — unchanged.

Invariant: a character holds at most one of `seatId` / `restSeatId` at a time, except for the brief moment a rest claim is released because work started (already handled in the FSM).

### Claiming

`claimWorkSeat(ch, seats, zoneOf, areaLabels)` in `seatPlacement.ts` (pure, tested). Returns a seat uid or null, in this order, considering only unassigned seats:

1. `preferredSeatId` if free and `role === 'work'`.
2. Nearest free work seat (Manhattan from the character's tile) whose area is one of `areaLabels` (folder → areas mapping), when any.
3. Nearest free unzoned work seat.
4. Nearest free work seat.
5. Nearest free rest seat (the office is oversubscribed; working on the sofa beats standing — the user's decision).
6. null.

Stages 2–4 mirror `findFreeSeat`'s stages so Areas keep working; the difference is proximity replaces random choice.

The FSM claims when `shouldBeSeated(ch)` is true and `seatId` is null (IDLE and WALK branches, replacing the `if (!ch.seatId) { TYPE }` lines). Claim before pathfinding, roll back if unreachable, exactly like the rest-seat claim. A claimed seat is not re-evaluated while held: an agent working on a sofa stays there until it stops working (no seat-hopping).

### Releasing

The seat is released at the moment the character steps off the desk to wander — the TYPE→IDLE transition taken when `!shouldBeSeated` and no rest seat — and on `removeAgent`, `removeSubagent` (belt), and `rebuildFromLayout`. `sendToSeat` (manual seating of an idle agent) claims the preferred seat for the existing `INACTIVE_SEAT_TIMER` window; the timer expiry path releases it like any step-off.

### No seat available

When `claimWorkSeat` returns null the character walks to the **waiting spot**: the free walkable tile nearest to the nearest work seat (`closestFreeWalkableTile` around that seat's tile), faces the seat, and stands in IDLE with a `seatWait` flag. The TYPE animation is never entered without a seat. Every tick while `seatWait` and `shouldBeSeated`, it retries `claimWorkSeat` (the seats map is small; no throttle needed). When work ends, `seatWait` clears and normal wandering resumes.

The activity label still shows the tool (the agent is working); only the animation is standing.

### Spawn and restore

Unchanged for the user: a new agent is placed at `findFreeSeat(folderName)` as today; that seat becomes both `preferredSeatId` and, since it spawns idle, is claimed for the existing idle sit window and released on wander-off. Restored agents (`existingAgents`) get `preferredSeatId` from the persisted `seatId` and are placed on it if free, otherwise at the nearest free walkable tile to it. Teammates keep `nearAgentId` clustering: `anchorTile` uses the lead's claimed seat, else its preferred seat, else its tile.

### Manual reassignment

Click character → click seat sets `preferredSeatId`. If the agent should be seated, release the current claim and claim the target immediately (walk there). If idle, behave as today (`sendToSeat`). Only work seats are assignable, unchanged.

### Other consumers of `seatId`

- `rebuildFurnitureInstances` (electronics auto-on): claimed seat — correct as is.
- Renderer selected-seat highlight and cursor seat hit-testing: claimed seat, else preferred.
- `testHooks.getAgentSeats` (e2e): reports `seatId ?? preferredSeatId` so existing e2e area-membership and "both seated" assertions, which read right after spawn, keep their meaning.
- `getPersistableSeats`: `preferredSeatId ?? seatId`.

### Tests (webview, Node runner)

- New `work-seat-claim.test.ts`: `claimWorkSeat` stage order; preferred-seat-first; area preference; rest fallback; null when nothing free.
- `rest-seat-fsm.test.ts`: becoming active with no claim claims the nearest free work seat; step-off releases; waiting spot when nothing is free (no TYPE state, `seatWait` set); claim retried and taken when a seat frees; work starting on a sofa keeps the sofa.
- `work-seat-selection.test.ts`, `rest-seat-officestate.test.ts`, `teammateSeating.test.ts`: updated for preferred vs claimed (spawn still lands on a seat; `removeAgent` frees both; `rebuildFromLayout` re-claims for characters that should be seated and clears the rest).
- `existingAgents` restore: preferred seat honoured when free.

E2E: existing specs are expected to pass unchanged because spawn-time seating is preserved and `getAgentSeats` reports the preferred seat. Run the full suite before merging; if `lifecycle.spec.ts` "one character seated" reads the visual state rather than the hook, adjust the assertion to the hook.

---

## Sequencing

1. Part A (independent, smallest).
2. Part C (protocol + small handler; unblocks the rail work).
3. Part B server (provider seams, attach module, restart fix), then Part B webview.
4. Part D.

Each part is a separate commit series with its own review.

## Open risks

- Claude's registry format is undocumented and may change; `findLiveProcess` treats any parse failure as "no live process", which degrades to "resume without stopping", never to a wrong kill. A wrong kill is impossible because the pid comes from a file whose `sessionId` must equal the agent's.
- Two processes on one session for the ~1 s between SIGTERM and exit: the resume is not started until the process is gone, so there is no overlap.
- Dynamic seats change the office's look for everyone on this fork: idle agents no longer keep "their" chair. The user chose this deliberately.
