# Band Size Persistence + Rename After Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The standalone terminal band remembers its dragged size across hide/show, and any agent can be renamed from the rail after it exists.

**Architecture:** Band size joins the rail width in `panelPosition.ts` (localStorage, per browser). Rename is a new privileged `renameAgent` client message handled in `clientMessageHandler.ts`, persisted on the agent, and echoed through the existing `agentRenamed` broadcast; the rail gets an inline edit input. `''` means "cleared" end to end.

**Tech Stack:** TypeScript, React 19 (webview), Fastify + AsyncAPI 3.0 contract (server), Vitest for both tiers.

**Spec:** `docs/superpowers/specs/2026-09-29-adopted-terminals-and-claimed-seats-design.md` — Part A and Part C.

## Global Constraints

- Standalone adapter only; `adapters/vscode/` is not touched.
- Every new wire message goes into the matching `oneOf` union in `core/asyncapi.yaml` with `additionalProperties: false`; then `npm run asyncapi:generate` and commit `core/src/messages.ts` (CI fails on drift). Update the variant counts in CLAUDE.md ("ServerMessage variants" / "ClientMessage variants") to the real union lengths.
- Constants never inline: server timing/limits in `server/src/constants.ts`, webview numbers in `webview-ui/src/constants.ts`.
- Webview TS: no `enum`, `import type` for type-only imports, `.js` extension on relative imports in server code.
- ESLint custom rules block inline hex/rgb colors, non-pixel shadows, and non-FS-Pixel-Sans fonts in webview code — use existing Tailwind utility classes / CSS variables only.
- Rename max length: `AGENT_TITLE_MAX_LEN = 80` (server constant), silently truncated after trim.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

- A stored band height above the max (e.g. after a constants change) must be clamped on load, not applied raw — Task 1 tests clamp on load.
- A rename to whitespace only must clear the title, not store `'   '` — Task 4 tests trim-to-clear.
- `agentRenamed` with `''` must delete the webview entry so the nameplate falls back to the terminal name; today it would render an empty label — Task 5 tests `characterLabel('')`.
- An unprivileged socket sending `renameAgent` must change nothing and emit nothing — Task 4 tests it.
- Pressing Escape in the rail input must restore the old label with no message sent — Task 6 (manual check; the rail is React, not unit-tested by policy).

---

### Task 1: Band height/width persistence helpers

**Files:**

- Modify: `webview-ui/src/components/terminal/panelPosition.ts` (append after the rail width section)
- Test: `webview-ui/test/panel-position.test.ts` (append a describe block)

**Interfaces:**

- Consumes: `TERMINAL_BAND_DEFAULT_HEIGHT_PX`, `TERMINAL_BAND_MIN_HEIGHT_PX`, `TERMINAL_BAND_MAX_HEIGHT_PX`, `TERMINAL_BAND_DEFAULT_WIDTH_PX`, `TERMINAL_BAND_MIN_WIDTH_PX`, `TERMINAL_BAND_MAX_WIDTH_PX` from `webview-ui/src/constants.ts` (all exist).
- Produces: `loadBandHeight(): number`, `saveBandHeight(h: number): void`, `loadBandWidth(): number`, `saveBandWidth(w: number): void`.

- [ ] **Step 1: Write the failing tests**

Append to `webview-ui/test/panel-position.test.ts` (the file already defines `stubLocalStorage()` at module scope; extend the import lists as shown):

```ts
import {
  loadBandHeight,
  loadBandWidth,
  saveBandHeight,
  saveBandWidth,
} from '../src/components/terminal/panelPosition.js';
import {
  TERMINAL_BAND_DEFAULT_HEIGHT_PX,
  TERMINAL_BAND_DEFAULT_WIDTH_PX,
  TERMINAL_BAND_MAX_HEIGHT_PX,
  TERMINAL_BAND_MAX_WIDTH_PX,
  TERMINAL_BAND_MIN_HEIGHT_PX,
  TERMINAL_BAND_MIN_WIDTH_PX,
} from '../src/constants.js';

describe('terminal band size persistence', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults with nothing stored', () => {
    expect(loadBandHeight()).toBe(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_DEFAULT_WIDTH_PX);
  });

  it('round-trips height and width independently', () => {
    saveBandHeight(TERMINAL_BAND_MIN_HEIGHT_PX + 17);
    saveBandWidth(TERMINAL_BAND_MIN_WIDTH_PX + 23);
    expect(loadBandHeight()).toBe(TERMINAL_BAND_MIN_HEIGHT_PX + 17);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_MIN_WIDTH_PX + 23);
  });

  it('clamps on save and on load', () => {
    saveBandHeight(TERMINAL_BAND_MAX_HEIGHT_PX + 500);
    expect(loadBandHeight()).toBe(TERMINAL_BAND_MAX_HEIGHT_PX);
    store['pixel-agents.terminalBandWidth'] = String(TERMINAL_BAND_MIN_WIDTH_PX - 1);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_MIN_WIDTH_PX);
    store['pixel-agents.terminalBandHeight'] = String(TERMINAL_BAND_MAX_HEIGHT_PX + 1);
    expect(loadBandHeight()).toBe(TERMINAL_BAND_MAX_HEIGHT_PX);
  });

  it('falls back to the default on garbage', () => {
    store['pixel-agents.terminalBandHeight'] = 'tall';
    store['pixel-agents.terminalBandWidth'] = '-4';
    expect(loadBandHeight()).toBe(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_DEFAULT_WIDTH_PX);
  });

  it('survives a throwing localStorage', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveBandHeight(300)).not.toThrow();
    expect(loadBandHeight()).toBe(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_DEFAULT_WIDTH_PX);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webview-ui && npx vitest run test/panel-position.test.ts`
Expected: FAIL — `loadBandHeight` is not exported.

- [ ] **Step 3: Implement the helpers**

Append to `webview-ui/src/components/terminal/panelPosition.ts` and extend its constants import:

```ts
import {
  TERMINAL_BAND_DEFAULT_HEIGHT_PX,
  TERMINAL_BAND_DEFAULT_WIDTH_PX,
  TERMINAL_BAND_MAX_HEIGHT_PX,
  TERMINAL_BAND_MAX_WIDTH_PX,
  TERMINAL_BAND_MIN_HEIGHT_PX,
  TERMINAL_BAND_MIN_WIDTH_PX,
  TERMINAL_RAIL_DEFAULT_WIDTH_PX,
  TERMINAL_RAIL_MAX_WIDTH_PX,
  TERMINAL_RAIL_MIN_WIDTH_PX,
} from '../../constants.js';

// ── Terminal band size (edge-handle drag; height for bottom, width for sides) ─
// The band unmounts when hidden, so React state alone forgets the drag.
const BAND_HEIGHT_KEY = 'pixel-agents.terminalBandHeight';
const BAND_WIDTH_KEY = 'pixel-agents.terminalBandWidth';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function loadSize(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function saveSize(key: string, value: number, min: number, max: number): void {
  try {
    localStorage.setItem(key, String(clamp(value, min, max)));
  } catch {
    /* per-browser convenience only — losing it is acceptable */
  }
}

export function loadBandHeight(): number {
  return loadSize(
    BAND_HEIGHT_KEY,
    TERMINAL_BAND_DEFAULT_HEIGHT_PX,
    TERMINAL_BAND_MIN_HEIGHT_PX,
    TERMINAL_BAND_MAX_HEIGHT_PX,
  );
}

export function saveBandHeight(height: number): void {
  saveSize(BAND_HEIGHT_KEY, height, TERMINAL_BAND_MIN_HEIGHT_PX, TERMINAL_BAND_MAX_HEIGHT_PX);
}

export function loadBandWidth(): number {
  return loadSize(
    BAND_WIDTH_KEY,
    TERMINAL_BAND_DEFAULT_WIDTH_PX,
    TERMINAL_BAND_MIN_WIDTH_PX,
    TERMINAL_BAND_MAX_WIDTH_PX,
  );
}

export function saveBandWidth(width: number): void {
  saveSize(BAND_WIDTH_KEY, width, TERMINAL_BAND_MIN_WIDTH_PX, TERMINAL_BAND_MAX_WIDTH_PX);
}
```

Also rewrite the existing `clampRailWidth`/`loadRailWidth`/`saveRailWidth` to use `clamp`/`loadSize`/`saveSize` so there is one implementation (behaviour identical; the existing rail tests must still pass).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd webview-ui && npx vitest run test/panel-position.test.ts`
Expected: PASS, including the pre-existing rail-width cases.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/terminal/panelPosition.ts webview-ui/test/panel-position.test.ts
git commit -m "feat(webview): persist terminal band height/width per browser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: TerminalBand seeds from and saves to the helpers

**Files:**

- Modify: `webview-ui/src/components/terminal/TerminalBand.tsx` (state init at the `useState(TERMINAL_BAND_DEFAULT_HEIGHT_PX)` / `useState(TERMINAL_BAND_DEFAULT_WIDTH_PX)` lines; `onHandlePointerMove`; `onHandlePointerUp`)

**Interfaces:**

- Consumes: Task 1's `loadBandHeight`, `saveBandHeight`, `loadBandWidth`, `saveBandWidth`.

- [ ] **Step 1: Seed state from storage**

Change the two `useState` lines to lazy initializers and extend the `panelPosition.js` import:

```ts
import {
  loadBandHeight,
  loadBandWidth,
  loadRailWidth,
  saveBandHeight,
  saveBandWidth,
  saveRailWidth,
} from './panelPosition.js';
// …
const [height, setHeight] = useState(() => loadBandHeight());
const [width, setWidth] = useState(() => loadBandWidth());
```

`TERMINAL_BAND_DEFAULT_HEIGHT_PX` / `TERMINAL_BAND_DEFAULT_WIDTH_PX` are no longer used in this file — drop them from the constants import (noUnusedLocals).

- [ ] **Step 2: Save on pointer-up**

The rAF-throttled `onHandlePointerMove` sets state asynchronously, so pointer-up cannot read `height`/`width` from the closure reliably. Mirror the rail divider's `railWidthRef` pattern: add `const sizeRef = useRef({ height, width });`, write the clamped value into it inside the rAF callback next to each `setWidth(...)`/`setHeight(...)`, and save on pointer-up:

```ts
const sizeRef = useRef({ height, width });
// inside the rAF callback:
if (drag.vertical) {
  const next = Math.min(
    TERMINAL_BAND_MAX_WIDTH_PX,
    Math.max(TERMINAL_BAND_MIN_WIDTH_PX, drag.startSize + delta),
  );
  sizeRef.current.width = next;
  setWidth(next);
} else {
  const next = Math.min(
    TERMINAL_BAND_MAX_HEIGHT_PX,
    Math.max(TERMINAL_BAND_MIN_HEIGHT_PX, drag.startSize + delta),
  );
  sizeRef.current.height = next;
  setHeight(next);
}
// …
const onHandlePointerUp = useCallback(() => {
  const drag = dragRef.current;
  if (drag) {
    if (drag.vertical) saveBandWidth(sizeRef.current.width);
    else saveBandHeight(sizeRef.current.height);
  }
  dragRef.current = null;
}, []);
```

- [ ] **Step 3: Type-check, lint, and check by hand**

Run: `npm run check-types && npm run lint`
Expected: clean.

Manual: `npm run build:webview`, restart the daemon (`node dist/cli.js`), open the printed URL, drag the band taller, click empty floor (band closes), click an agent with a terminal (band reopens) — it must reopen at the dragged height. Repeat with Settings → Terminal Position → Right for width.

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/terminal/TerminalBand.tsx
git commit -m "fix(webview): terminal band keeps its dragged size across hide/show

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `renameAgent` on the wire

**Files:**

- Modify: `core/asyncapi.yaml` (ClientMessage `oneOf` list near line 133; add a `RenameAgent` schema next to `CloseAgent`)
- Regenerate: `core/src/messages.ts`
- Modify: `CLAUDE.md` line ~200 (ClientMessage variant count; mention `renameAgent` in the lifecycle group)

**Interfaces:**

- Produces: `ClientMessage` variant `{ type: 'renameAgent'; id: number; customTitle: string }`.

- [ ] **Step 1: Add the schema and union entry**

In the `ClientMessage.oneOf` list, after `- $ref: '#/components/schemas/CloseAgent'`, add:

```yaml
- $ref: '#/components/schemas/RenameAgent'
```

After the `CloseAgent` schema block, add:

```yaml
RenameAgent:
  description: >-
    Set or clear an agent's display name (customTitle) after launch.
    An empty string clears it. Privileged only.
  type: object
  additionalProperties: false
  required: [type, id, customTitle]
  properties:
    type:
      const: renameAgent
    id:
      type: integer
    customTitle:
      type: string
```

- [ ] **Step 2: Regenerate and validate**

Run: `npm run asyncapi:validate && npm run asyncapi:generate && git diff --stat core/src/messages.ts`
Expected: validation passes; `messages.ts` diff adds a `RenameAgent` type to the `ClientMessage` union.

- [ ] **Step 3: Update the CLAUDE.md count**

Run: `grep -c "^        - \\$ref: '#/components/schemas/" core/asyncapi.yaml` is not selective enough; instead count each union with:

```bash
awk '/^    ServerMessage:$/{s=1} /^    ClientMessage:$/{s=2} /^      discriminator: type/{s=0} s==1&&/\$ref/{a++} s==2&&/\$ref/{b++} END{print "server="a, "client="b}' core/asyncapi.yaml
```

Put those two numbers into the two CLAUDE.md bullets and add `renameAgent` to the lifecycle parenthetical of the ClientMessage bullet.

- [ ] **Step 4: Commit**

```bash
git add core/asyncapi.yaml core/src/messages.ts CLAUDE.md
git commit -m "feat(protocol): renameAgent client message

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Server handles `renameAgent`

**Files:**

- Modify: `server/src/constants.ts` (append under "In-office pty terminals")
- Modify: `server/src/clientMessageHandler.ts` (new `case 'renameAgent'` next to `case 'closeAgent'`)
- Test: `server/__tests__/clientMessageHandler.pty.test.ts` (new describe block inside the existing top-level describe, reusing `makeCtx`, `send`, `broadcasts`, `store`)

**Interfaces:**

- Consumes: Task 3's message type.
- Produces: `AGENT_TITLE_MAX_LEN = 80`; broadcast `{ type: 'agentRenamed', id, customTitle }` where `customTitle` is the trimmed, truncated title or `''` when cleared.

- [ ] **Step 1: Write the failing tests**

```ts
describe('renameAgent', () => {
  it('privileged: trims, persists, and broadcasts agentRenamed', () => {
    const ctx = makeCtx(null);
    store.set(1, createTestAgent({ id: 1 }));
    handleClientMessage({ type: 'renameAgent', id: 1, customTitle: '  Budget bot  ' }, send, ctx);
    expect(store.get(1)!.customTitle).toBe('Budget bot');
    expect(broadcasts.at(-1)).toEqual({ type: 'agentRenamed', id: 1, customTitle: 'Budget bot' });
    expect(store.loadPersistedAgents().find((a) => a.id === 1)?.customTitle).toBe('Budget bot');
  });

  it('whitespace-only clears the title and broadcasts an empty string', () => {
    const ctx = makeCtx(null);
    store.set(1, createTestAgent({ id: 1, customTitle: 'Old' }));
    handleClientMessage({ type: 'renameAgent', id: 1, customTitle: '   ' }, send, ctx);
    expect(store.get(1)!.customTitle).toBeUndefined();
    expect(broadcasts.at(-1)).toEqual({ type: 'agentRenamed', id: 1, customTitle: '' });
    expect(store.loadPersistedAgents().find((a) => a.id === 1)?.customTitle).toBeUndefined();
  });

  it('truncates to AGENT_TITLE_MAX_LEN after trimming', () => {
    const ctx = makeCtx(null);
    store.set(1, createTestAgent({ id: 1 }));
    handleClientMessage(
      { type: 'renameAgent', id: 1, customTitle: ' ' + 'x'.repeat(200) },
      send,
      ctx,
    );
    expect(store.get(1)!.customTitle).toBe('x'.repeat(AGENT_TITLE_MAX_LEN));
  });

  it('works for external (adopted) agents too', () => {
    const ctx = makeCtx(null);
    store.set(4, createTestAgent({ id: 4, isExternal: true }));
    handleClientMessage({ type: 'renameAgent', id: 4, customTitle: 'Songer' }, send, ctx);
    expect(store.get(4)!.customTitle).toBe('Songer');
  });

  it('unprivileged: no change, no broadcast', () => {
    const ctx = makeCtx(null, false);
    store.set(1, createTestAgent({ id: 1, customTitle: 'Keep' }));
    handleClientMessage({ type: 'renameAgent', id: 1, customTitle: 'Nope' }, send, ctx);
    expect(store.get(1)!.customTitle).toBe('Keep');
    expect(broadcasts.find((b) => b.type === 'agentRenamed')).toBeUndefined();
  });

  it('unknown id or non-string title: no-op', () => {
    const ctx = makeCtx(null);
    handleClientMessage({ type: 'renameAgent', id: 99, customTitle: 'x' }, send, ctx);
    store.set(1, createTestAgent({ id: 1, customTitle: 'Keep' }));
    handleClientMessage({ type: 'renameAgent', id: 1, customTitle: 42 }, send, ctx);
    expect(store.get(1)!.customTitle).toBe('Keep');
    expect(broadcasts.find((b) => b.type === 'agentRenamed')).toBeUndefined();
  });
});
```

Add `import { AGENT_TITLE_MAX_LEN } from '../src/constants.js';` to the test's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.pty.test.ts -t renameAgent`
Expected: FAIL — `AGENT_TITLE_MAX_LEN` not exported / title unchanged.

- [ ] **Step 3: Implement**

`server/src/constants.ts`, after `RECENT_AGENT_FOLDERS_MAX`:

```ts
/** Max length of a user-chosen agent display name (renameAgent / New-agent form). */
export const AGENT_TITLE_MAX_LEN = 80;
```

`server/src/clientMessageHandler.ts`, import `AGENT_TITLE_MAX_LEN` from `./constants.js` and add after the `closeAgent` case:

```ts
    case 'renameAgent': {
      // Privileged: a title is user-visible state persisted under ~/.pixel-agents.
      if (!ctx.privileged) break;
      const id = msg.id as number;
      const agent = store.get(id);
      if (!agent || typeof msg.customTitle !== 'string') break;
      const title = (msg.customTitle as string).trim().slice(0, AGENT_TITLE_MAX_LEN);
      // '' means "cleared" end to end: undefined on the agent, '' on the wire.
      agent.customTitle = title || undefined;
      store.persist();
      store.broadcast({ type: 'agentRenamed', id, customTitle: title });
      break;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.pty.test.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add server/src/constants.ts server/src/clientMessageHandler.ts server/__tests__/clientMessageHandler.pty.test.ts
git commit -m "feat(server): renameAgent sets, clears, persists and broadcasts customTitle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Webview treats `''` as "no title"

**Files:**

- Modify: `webview-ui/src/office/engine/characters.ts` (`characterLabel`, ~line 414, and its doc comment)
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts` (`agentRenamed` branch, ~line 830)
- Test: `webview-ui/test/character-label.test.ts` (new)

**Interfaces:**

- Produces: `characterLabel` ignores empty-string `customTitle`/`agentName`/`terminalName`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * `characterLabel` picks the display name for a character. An empty string is
 * "no title" (the renameAgent clear path broadcasts ''), never a winning label.
 *
 * Run with: npm run test:webview -- test/character-label.test.ts
 */
import { describe, expect, it } from 'vitest';

import { characterLabel } from '../src/office/engine/characters.js';

describe('characterLabel', () => {
  it('prefers customTitle, then agentName, then terminalName, then Agent #id', () => {
    expect(
      characterLabel({ id: 7, customTitle: 'Budget', agentName: 'a', terminalName: 't' }),
    ).toBe('Budget');
    expect(characterLabel({ id: 7, agentName: 'researcher', terminalName: 't' })).toBe(
      'researcher',
    );
    expect(characterLabel({ id: 7, terminalName: 'Claude Code #2' })).toBe('Claude Code #2');
    expect(characterLabel({ id: 7 })).toBe('Agent #7');
  });

  it('treats an empty string as absent at every level', () => {
    expect(characterLabel({ id: 7, customTitle: '', terminalName: 'Claude Code #2' })).toBe(
      'Claude Code #2',
    );
    expect(characterLabel({ id: 7, customTitle: '', agentName: '', terminalName: '' })).toBe(
      'Agent #7',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd webview-ui && npx vitest run test/character-label.test.ts`
Expected: FAIL — `''` is returned as the label.

- [ ] **Step 3: Implement**

`characters.ts`:

```ts
/** Display name for a character: user title, then teammate name, then the
 *  terminal's name, then "Agent #id". Empty strings count as absent — the
 *  renameAgent clear path broadcasts '' and must fall through. */
export function characterLabel(ch: {
  customTitle?: string;
  agentName?: string;
  terminalName?: string;
  id: number;
}): string {
  return ch.customTitle || ch.agentName || ch.terminalName || `Agent #${ch.id}`;
}
```

`useExtensionMessages.ts`, `agentRenamed` branch:

```ts
      } else if (msg.type === 'agentRenamed') {
        const id = msg.id as number;
        if (typeof id === 'number' && typeof msg.customTitle === 'string') {
          const title = msg.customTitle as string;
          setCustomTitles((prev) => {
            if (!title) {
              const { [id]: _cleared, ...rest } = prev;
              return rest;
            }
            return { ...prev, [id]: title };
          });
        }
      }
```

If the linter rejects the unused `_cleared` destructure, use `const next = { ...prev }; delete next[id]; return next;` instead.

- [ ] **Step 4: Run tests, types, lint**

Run: `cd webview-ui && npx vitest run && cd .. && npm run check-types && npm run lint`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/engine/characters.ts webview-ui/src/hooks/useExtensionMessages.ts webview-ui/test/character-label.test.ts
git commit -m "fix(webview): empty customTitle means cleared, not an empty label

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Inline rename in the rail

**Files:**

- Modify: `webview-ui/src/components/terminal/AgentRail.tsx` (props + entry markup)
- Modify: `webview-ui/src/components/terminal/TerminalBand.tsx` (thread `onRename`)
- Modify: `webview-ui/src/App.tsx` (send `renameAgent`)

**Interfaces:**

- Consumes: Task 3's message; `RailAgent { id, label }` (exists).
- Produces: `AgentRailProps.onRename: (id: number, customTitle: string) => void`; `TerminalBandProps.onRename` with the same signature.

- [ ] **Step 1: Rail entry with a pencil and an inline input**

Replace the body of `AgentRail.tsx` with (keeps every existing class and aria attribute; adds `onRename` and per-entry edit state):

```tsx
import { useState } from 'react';

export interface RailAgent {
  id: number;
  label: string;
}

interface AgentRailProps {
  agents: RailAgent[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Commit a new display name ('' clears it). */
  onRename: (id: number, customTitle: string) => void;
  /** Dragged via the rail/pane divider in TerminalBand (persisted there). */
  width: number;
}

/** Vertical list of agents on the left edge of the terminal band. Click
 *  focuses that agent's terminal; ✎ renames inline; ✕ closes the agent. The
 *  rail/pane divider (TerminalBand) is the visual separator — no own right border. */
export function AgentRail({
  agents,
  focusedId,
  onFocus,
  onClose,
  onRename,
  width,
}: AgentRailProps) {
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);

  const commit = () => {
    if (!editing) return;
    const current = agents.find((a) => a.id === editing.id);
    const next = editing.draft.trim();
    if (current && next !== current.label) onRename(editing.id, next);
    setEditing(null);
  };

  return (
    <div
      className="flex flex-col overflow-y-auto"
      style={{ width, flex: `0 0 ${width}px`, background: 'var(--color-bg)' }}
      role="tablist"
      aria-label="Agent terminals"
    >
      {agents.map((agent) => {
        const focused = agent.id === focusedId;
        const isEditing = editing?.id === agent.id;
        return (
          <div
            key={agent.id}
            role="tab"
            aria-selected={focused}
            tabIndex={0}
            onClick={() => onFocus(agent.id)}
            onKeyDown={(e) => {
              if (isEditing) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFocus(agent.id);
              }
            }}
            className="flex items-center gap-4 px-6 py-4 cursor-pointer border-b-2 border-border text-2xs"
            style={{
              background: focused ? 'var(--color-active-bg)' : 'transparent',
              color: focused ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}
          >
            {isEditing ? (
              <input
                type="text"
                value={editing.draft}
                autoFocus
                onChange={(e) => setEditing({ id: agent.id, draft: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onBlur={commit}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commit();
                  else if (e.key === 'Escape') setEditing(null);
                }}
                className="flex-1 min-w-0 text-2xs py-1 px-2 bg-bg border-2 border-border rounded-none text-text"
                aria-label={`Rename ${agent.label}`}
              />
            ) : (
              <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {agent.label}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing({ id: agent.id, draft: agent.label });
              }}
              className="bg-transparent border-none cursor-pointer text-2xs text-text-muted hover:text-text px-2"
              title="Rename agent"
              aria-label={`Rename ${agent.label}`}
            >
              ✎
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(agent.id);
              }}
              className="bg-transparent border-none cursor-pointer text-2xs text-text-muted hover:text-danger px-2"
              title="Close agent"
              aria-label={`Close ${agent.label}`}
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

Escape cancels without sending anything: `setEditing(null)` runs before blur can commit because the input unmounts; if blur still fires in practice, guard `commit` with `if (!editing) return` (already there).

- [ ] **Step 2: Thread `onRename` through TerminalBand and App**

`TerminalBand.tsx`: add `onRename: (id: number, customTitle: string) => void;` to `TerminalBandProps`, destructure it, pass `onRename={onRename}` to `<AgentRail …>`.

`App.tsx`, next to `handleCloseAgent`:

```ts
const handleRenameAgent = useCallback((id: number, customTitle: string) => {
  transport.send({ type: 'renameAgent', id, customTitle });
}, []);
```

and `onRename={handleRenameAgent}` on `<TerminalBand …>`.

- [ ] **Step 3: Types, lint, manual check**

Run: `npm run check-types && npm run lint && npm run build:webview`
Expected: clean.

Manual (daemon restarted on the new build): click ✎ on a rail entry, type a name, Enter — the rail label and the character's nameplate change; reload the page — the name survives (persisted). Clear the name (empty, Enter) — the label falls back to "Claude Code #N". Escape while editing — old label, no change.

- [ ] **Step 4: Commit**

```bash
git add webview-ui/src/components/terminal/AgentRail.tsx webview-ui/src/components/terminal/TerminalBand.tsx webview-ui/src/App.tsx
git commit -m "feat(webview): rename agents inline from the terminal rail

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run every check CI runs, minus e2e**

Run: `npm run lint && npm run asyncapi:validate && npm run asyncapi:generate && git diff --exit-code core/src/messages.ts && npm run check-types && npm test`
Expected: all clean; `git diff --exit-code` prints nothing.

- [ ] **Step 2: Run the standalone e2e slice**

Run: `npm run e2e -- --workers=1 --grep "standalone"`
Expected: PASS (nothing in this plan changes the standalone hook path; this guards the protocol regeneration).
