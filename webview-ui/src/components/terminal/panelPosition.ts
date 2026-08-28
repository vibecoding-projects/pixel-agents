/**
 * Terminal-band dock position: bottom (default), left, or right.
 *
 * Webview-local persistence (localStorage) rather than the per-namespace
 * server config: the dock side is a per-browser layout preference of the
 * standalone surface only (the band renders only under isBrowserRuntime),
 * matching v2-orchestrator's panelPersistence. localStorage can be absent or
 * throw (Node test runner, blocked site data), so every access is guarded and
 * the default wins.
 */
import {
  TERMINAL_RAIL_DEFAULT_WIDTH_PX,
  TERMINAL_RAIL_MAX_WIDTH_PX,
  TERMINAL_RAIL_MIN_WIDTH_PX,
} from '../../constants.js';

export type PanelPosition = 'bottom' | 'left' | 'right';

const STORAGE_KEY = 'pixel-agents.panelPosition';

function isPanelPosition(v: unknown): v is PanelPosition {
  return v === 'bottom' || v === 'left' || v === 'right';
}

export function loadPanelPosition(): PanelPosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isPanelPosition(raw) ? raw : 'bottom';
  } catch {
    return 'bottom';
  }
}

export function savePanelPosition(position: PanelPosition): void {
  try {
    localStorage.setItem(STORAGE_KEY, position);
  } catch {
    /* per-browser convenience only — losing it is acceptable */
  }
}

// ── Terminal band open/closed (toggles with character selection) ─
const PANEL_OPEN_KEY = 'pixel-agents.terminalOpen';

export function loadPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function savePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_OPEN_KEY, String(open));
  } catch {
    /* per-browser convenience only — losing it is acceptable */
  }
}

// ── Agent rail width (the DevTools-style rail/pane divider) ─────
const RAIL_WIDTH_KEY = 'pixel-agents.terminalRailWidth';

function clampRailWidth(w: number): number {
  return Math.min(TERMINAL_RAIL_MAX_WIDTH_PX, Math.max(TERMINAL_RAIL_MIN_WIDTH_PX, w));
}

export function loadRailWidth(): number {
  try {
    const raw = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampRailWidth(raw) : TERMINAL_RAIL_DEFAULT_WIDTH_PX;
  } catch {
    return TERMINAL_RAIL_DEFAULT_WIDTH_PX;
  }
}

export function saveRailWidth(width: number): void {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(clampRailWidth(width)));
  } catch {
    /* per-browser convenience only — losing it is acceptable */
  }
}
