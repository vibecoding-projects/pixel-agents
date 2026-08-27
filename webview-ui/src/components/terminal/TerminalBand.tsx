import { useCallback, useEffect, useRef, useState } from 'react';

import {
  TERMINAL_BAND_DEFAULT_HEIGHT_PX,
  TERMINAL_BAND_DEFAULT_WIDTH_PX,
  TERMINAL_BAND_HANDLE_HEIGHT_PX,
  TERMINAL_BAND_MAX_HEIGHT_PX,
  TERMINAL_BAND_MAX_WIDTH_PX,
  TERMINAL_BAND_MIN_HEIGHT_PX,
  TERMINAL_BAND_MIN_WIDTH_PX,
} from '../../constants.js';
import type { PtyEventBus } from '../../office/panel/ptyEventBus.js';
import type { RailAgent } from './AgentRail.js';
import { AgentRail } from './AgentRail.js';
import type { PanelPosition } from './panelPosition.js';
import { TerminalPane } from './TerminalPane.js';

interface TerminalBandProps {
  agents: RailAgent[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  onRestartAgent: (id: number) => void;
  bus: PtyEventBus;
  /** Dock side (Settings → Terminal Position). Bottom drags height; left and
   *  right drag width. TerminalPane re-fits itself via its ResizeObserver. */
  position: PanelPosition;
}

/**
 * Terminal band for the browser runtime: drag-resize handle on the inner
 * edge, agent rail on the left, one xterm pane for the focused agent.
 * Dockable bottom / left / right (v2-orchestrator's OfficePanel positions).
 */
export function TerminalBand({
  agents,
  focusedId,
  onFocus,
  onClose,
  onRestartAgent,
  bus,
  position,
}: TerminalBandProps) {
  const isVertical = position !== 'bottom';
  const [height, setHeight] = useState(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
  const [width, setWidth] = useState(TERMINAL_BAND_DEFAULT_WIDTH_PX);
  const dragRef = useRef<{ start: number; startSize: number; vertical: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = isVertical
        ? { start: e.clientX, startSize: width, vertical: true }
        : { start: e.clientY, startSize: height, vertical: false };
    },
    [isVertical, width, height],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Dragging toward the office grows the band: up for bottom, left for a
      // right dock, right for a left dock.
      const delta = drag.vertical
        ? position === 'right'
          ? drag.start - e.clientX
          : e.clientX - drag.start
        : drag.start - e.clientY;
      if (rafRef.current !== null) return; // throttle to one update per frame
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (drag.vertical) {
          setWidth(
            Math.min(
              TERMINAL_BAND_MAX_WIDTH_PX,
              Math.max(TERMINAL_BAND_MIN_WIDTH_PX, drag.startSize + delta),
            ),
          );
        } else {
          setHeight(
            Math.min(
              TERMINAL_BAND_MAX_HEIGHT_PX,
              Math.max(TERMINAL_BAND_MIN_HEIGHT_PX, drag.startSize + delta),
            ),
          );
        }
      });
    },
    [position],
  );

  const onHandlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const focused = agents.find((a) => a.id === focusedId) ?? agents[0] ?? null;

  const handle = (
    <div
      onPointerDown={onHandlePointerDown}
      onPointerMove={onHandlePointerMove}
      onPointerUp={onHandlePointerUp}
      className={isVertical ? 'h-full cursor-col-resize' : 'w-full cursor-row-resize'}
      style={{
        ...(isVertical
          ? { width: TERMINAL_BAND_HANDLE_HEIGHT_PX }
          : { height: TERMINAL_BAND_HANDLE_HEIGHT_PX }),
        background: 'var(--color-bg-thumb)',
        touchAction: 'none',
        flex: '0 0 auto',
      }}
      role="separator"
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      aria-label="Resize terminal band"
    />
  );

  const content = (
    <div className="flex flex-1 min-h-0 min-w-0">
      <AgentRail
        agents={agents}
        focusedId={focused?.id ?? null}
        onFocus={onFocus}
        onClose={onClose}
      />
      {focused ? (
        <TerminalPane
          agentId={focused.id}
          agentName={focused.label}
          bus={bus}
          onRestartAgent={onRestartAgent}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-2xs text-text-muted">
          No agent terminal
        </div>
      )}
    </div>
  );

  if (isVertical) {
    // The handle sits on the band's INNER edge (facing the office): right edge
    // of a left dock, left edge of a right dock. Border mirrors it.
    return (
      <div
        className={`flex flex-row ${position === 'left' ? 'border-r-2' : 'border-l-2'} border-border`}
        style={{ width, flex: `0 0 ${width}px`, background: 'var(--color-bg)' }}
        data-testid="terminal-band"
        data-position={position}
      >
        {position === 'right' && handle}
        {content}
        {position === 'left' && handle}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col border-t-2 border-border"
      style={{ height, flex: `0 0 ${height}px`, background: 'var(--color-bg)' }}
      data-testid="terminal-band"
      data-position={position}
    >
      {handle}
      {content}
    </div>
  );
}
