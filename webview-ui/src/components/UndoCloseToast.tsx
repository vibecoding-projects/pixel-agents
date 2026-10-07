import { useEffect, useState } from 'react';

import { UNDO_TOAST_BOTTOM_PX, UNDO_TOAST_TICK_MS } from '../constants.js';
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
      style={{ bottom: UNDO_TOAST_BOTTOM_PX }}
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
