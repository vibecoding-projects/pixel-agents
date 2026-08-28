export interface RailAgent {
  id: number;
  label: string;
}

interface AgentRailProps {
  agents: RailAgent[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Dragged via the rail/pane divider in TerminalBand (persisted there). */
  width: number;
}

/** Vertical list of pty-backed agents on the left edge of the terminal band.
 *  Click focuses that agent's terminal; ✕ closes the agent. The rail/pane
 *  divider (TerminalBand) is the visual separator — no own right border. */
export function AgentRail({ agents, focusedId, onFocus, onClose, width }: AgentRailProps) {
  return (
    <div
      className="flex flex-col overflow-y-auto"
      style={{ width, flex: `0 0 ${width}px`, background: 'var(--color-bg)' }}
      role="tablist"
      aria-label="Agent terminals"
    >
      {agents.map((agent) => {
        const focused = agent.id === focusedId;
        return (
          <div
            key={agent.id}
            role="tab"
            aria-selected={focused}
            tabIndex={0}
            onClick={() => onFocus(agent.id)}
            onKeyDown={(e) => {
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
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {agent.label}
            </span>
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
