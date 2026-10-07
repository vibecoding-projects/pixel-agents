import { useEffect, useRef, useState } from 'react';

import type { ClosedSessionSummary } from '../../../../core/src/messages.js';
import { CLOSED_LIST_CLOCK_MS } from '../../constants.js';
import { relativeTime } from './relativeTime.js';

export interface RailAgent {
  id: number;
  label: string;
  /** False for an adopted session still running outside the office. */
  inOffice: boolean;
  moveState: 'idle' | 'pending' | 'error';
  moveError?: string;
}

interface AgentRailProps {
  agents: RailAgent[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Commit a new display name ('' clears it). */
  onRename: (id: number, customTitle: string) => void;
  /** New top-to-bottom id order after a drag or Alt+arrow. */
  onReorder: (order: number[]) => void;
  /** The Closed list (restorable sessions), newest first. */
  closedSessions: ClosedSessionSummary[];
  onRestore: (sessionId: string) => void;
  onForget: (sessionId: string) => void;
  /** Dragged via the rail/pane divider in TerminalBand (persisted there). */
  width: number;
}

/** Vertical list of agents on the left edge of the terminal band: in-office
 *  (pty-backed) ones and adopted sessions still running outside the office,
 *  which render muted with an "outside" marker. Click focuses that agent's
 *  terminal (or moves an outside session in); ✎ renames inline; ✕ closes the
 *  agent (undoable for a few seconds). Rows drag to reorder (Alt+↑/↓ too).
 *  A "Closed" section at the bottom lists restorable sessions while there are
 *  any. The rail/pane divider (TerminalBand) is the visual separator — no
 *  own right border. */
export function AgentRail({
  agents,
  focusedId,
  onFocus,
  onClose,
  onRename,
  onReorder,
  closedSessions,
  onRestore,
  onForget,
  width,
}: AgentRailProps) {
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  // Escape must beat blur: when the input unmounts, the previous render's
  // onBlur can still fire with a stale closure. Both handlers read this ref,
  // which Escape nulls synchronously before the state update.
  const editingRef = useRef<{ id: number; draft: string } | null>(null);
  const setEdit = (next: { id: number; draft: string } | null) => {
    editingRef.current = next;
    setEditing(next);
  };

  const commit = () => {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    const entry = agents.find((a) => a.id === current.id);
    const next = current.draft.trim();
    if (entry && next !== entry.label) onRename(current.id, next);
    setEditing(null);
  };

  // ── Drag to reorder ──
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; after: boolean } | null>(null);

  /** Move `id` so it lands at `targetIndex` in the list WITHOUT it. */
  const moveTo = (id: number, targetIndex: number) => {
    const ids = agents.map((a) => a.id);
    const from = ids.indexOf(id);
    if (from === -1) return;
    ids.splice(from, 1);
    const at = Math.max(0, Math.min(targetIndex, ids.length));
    if (at === from) return;
    ids.splice(at, 0, id);
    onReorder(ids);
  };

  // Clock for the Closed list's "closed N ago" labels (state, not Date.now()
  // in render: the React compiler rule forbids impure calls there).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (closedSessions.length === 0) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), CLOSED_LIST_CLOCK_MS);
    return () => clearInterval(t);
  }, [closedSessions.length]);

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
        const hinted = dropHint?.id === agent.id ? dropHint : null;
        // Insertion line = a border swap (never an inline box-shadow): every
        // row carries a transparent top border so nothing jumps.
        const hintClass = hinted ? (hinted.after ? ' border-b-accent' : ' border-t-accent') : '';
        return (
          <div
            key={agent.id}
            role="tab"
            aria-selected={focused}
            tabIndex={0}
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
              const after = e.clientY > box.top + box.height / 2;
              if (hinted?.after !== after) setDropHint({ id: agent.id, after });
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
            onClick={() => onFocus(agent.id)}
            onKeyDown={(e) => {
              if (isEditing) return;
              if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                const idx = agents.findIndex((a) => a.id === agent.id);
                moveTo(agent.id, e.key === 'ArrowUp' ? idx - 1 : idx + 1);
                return;
              }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFocus(agent.id);
              }
            }}
            className={`flex items-center gap-4 px-6 py-4 cursor-pointer border-t-2 border-t-transparent border-b-2 border-border text-2xs${
              agent.inOffice ? '' : ' opacity-60'
            }${hintClass}`}
            style={{
              background: focused ? 'var(--color-active-bg)' : 'transparent',
              color: focused ? 'var(--color-text)' : 'var(--color-text-muted)',
            }}
          >
            {!agent.inOffice && (
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
            {isEditing ? (
              <input
                type="text"
                value={editing.draft}
                autoFocus
                draggable={false}
                onChange={(e) => setEdit({ id: agent.id, draft: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onBlur={commit}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commit();
                  else if (e.key === 'Escape') setEdit(null);
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
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                setEdit({ id: agent.id, draft: agent.label });
              }}
              className="bg-transparent border-none cursor-pointer text-2xs text-text-muted hover:text-text px-2"
              title="Rename agent"
              aria-label={`Rename ${agent.label}`}
            >
              ✎
            </button>
            <button
              type="button"
              draggable={false}
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
      {closedSessions.length > 0 && (
        <div className="mt-auto border-t-2 border-border" data-testid="closed-sessions">
          <div className="px-6 py-2 text-2xs text-text-muted uppercase">Closed</div>
          {closedSessions.map((s) => {
            const label = s.customTitle || s.terminalName || s.sessionId.slice(0, 8);
            const ago = relativeTime(s.closedAt, now);
            return (
              <div
                key={s.sessionId}
                className="flex items-center gap-4 px-6 py-4 border-b-2 border-border text-2xs opacity-70"
                data-testid="closed-session"
              >
                <span
                  className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                  title={`closed ${ago}`}
                >
                  {label}
                  <span className="text-text-muted"> · {ago}</span>
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
      )}
    </div>
  );
}
