import { useCallback, useEffect, useRef, useState } from 'react';

import {
  TERMINAL_BAND_HANDLE_THICKNESS_PX,
  TERMINAL_BAND_MIN_HEIGHT_PX,
  TERMINAL_BAND_MIN_WIDTH_PX,
  TERMINAL_RAIL_MAX_WIDTH_PX,
  TERMINAL_RAIL_MIN_WIDTH_PX,
} from '../../constants.js';
import type { PtyEventBus } from '../../office/panel/ptyEventBus.js';
import type { RailAgent } from './AgentRail.js';
import { AgentRail } from './AgentRail.js';
import type { PanelPosition } from './panelPosition.js';
import {
  bandMaxHeight,
  bandMaxWidth,
  loadBandHeight,
  loadBandWidth,
  loadRailWidth,
  saveBandHeight,
  saveBandWidth,
  saveRailWidth,
} from './panelPosition.js';
import { TerminalPane } from './TerminalPane.js';

interface TerminalBandProps {
  agents: RailAgent[];
  focusedId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  onRestartAgent: (id: number) => void;
  /** Inline rename from the rail ('' clears the title). */
  onRename: (id: number, customTitle: string) => void;
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
  onRename,
  bus,
  position,
}: TerminalBandProps) {
  const isVertical = position !== 'bottom';
  // Seeded from localStorage: the band unmounts when hidden, so React state
  // alone forgets the drag (panelPosition.ts).
  const [height, setHeight] = useState(() => loadBandHeight());
  const [width, setWidth] = useState(() => loadBandWidth());
  const dragRef = useRef<{ start: number; startSize: number; vertical: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  // Written synchronously on every pointer move (ahead of the rAF throttle)
  // so pointer-up saves the final size, never one frame stale.
  const sizeRef = useRef({ height, width });

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
      // The cap follows the window (a fraction of it), not a fixed pixel count.
      if (drag.vertical) {
        sizeRef.current.width = Math.min(
          bandMaxWidth(window.innerWidth),
          Math.max(TERMINAL_BAND_MIN_WIDTH_PX, drag.startSize + delta),
        );
      } else {
        sizeRef.current.height = Math.min(
          bandMaxHeight(window.innerHeight),
          Math.max(TERMINAL_BAND_MIN_HEIGHT_PX, drag.startSize + delta),
        );
      }
      if (rafRef.current !== null) return; // throttle to one update per frame
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (drag.vertical) setWidth(sizeRef.current.width);
        else setHeight(sizeRef.current.height);
      });
    },
    [position],
  );

  const onHandlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag) {
      if (drag.vertical) saveBandWidth(sizeRef.current.width);
      else saveBandHeight(sizeRef.current.height);
    }
    dragRef.current = null;
  }, []);

  // DevTools-style divider between the agent rail and the terminal pane. The
  // rail is always LEFT of the pane, so dragging right grows it in every dock
  // position. Width persists per browser next to the dock side.
  const [railWidth, setRailWidth] = useState(() => loadRailWidth());
  const railWidthRef = useRef(railWidth);
  const railDragRef = useRef<{ start: number; startWidth: number } | null>(null);
  const railRafRef = useRef<number | null>(null);

  const onRailDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      railDragRef.current = { start: e.clientX, startWidth: railWidth };
    },
    [railWidth],
  );

  const onRailDividerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current;
    if (!drag) return;
    const delta = e.clientX - drag.start;
    if (railRafRef.current !== null) return; // throttle to one update per frame
    railRafRef.current = requestAnimationFrame(() => {
      railRafRef.current = null;
      const next = Math.min(
        TERMINAL_RAIL_MAX_WIDTH_PX,
        Math.max(TERMINAL_RAIL_MIN_WIDTH_PX, drag.startWidth + delta),
      );
      railWidthRef.current = next;
      setRailWidth(next);
    });
  }, []);

  const onRailDividerPointerUp = useCallback(() => {
    if (railDragRef.current) saveRailWidth(railWidthRef.current);
    railDragRef.current = null;
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
          ? { width: TERMINAL_BAND_HANDLE_THICKNESS_PX }
          : { height: TERMINAL_BAND_HANDLE_THICKNESS_PX }),
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
        onRename={onRename}
        width={railWidth}
      />
      <div
        onPointerDown={onRailDividerPointerDown}
        onPointerMove={onRailDividerPointerMove}
        onPointerUp={onRailDividerPointerUp}
        className="h-full cursor-col-resize"
        style={{
          width: TERMINAL_BAND_HANDLE_THICKNESS_PX,
          background: 'var(--color-bg-thumb)',
          touchAction: 'none',
          flex: '0 0 auto',
        }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agent rail"
      />
      {focused ? (
        focused.inOffice ? (
          <TerminalPane
            agentId={focused.id}
            agentName={focused.label}
            bus={bus}
            onRestartAgent={onRestartAgent}
          />
        ) : (
          // An adopted session still running outside the office: clicking
          // (re)requests the move through the same path as the rail entry.
          <div
            className={`flex-1 flex items-center justify-center text-2xs px-8 text-center ${
              focused.moveState === 'error' ? 'text-danger' : 'text-text-muted'
            } ${focused.moveState === 'pending' ? '' : 'cursor-pointer'}`}
            onClick={focused.moveState === 'pending' ? undefined : () => onFocus(focused.id)}
            role={focused.moveState === 'pending' ? undefined : 'button'}
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
