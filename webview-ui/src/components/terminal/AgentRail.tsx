import { useRef, useState } from 'react';

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
