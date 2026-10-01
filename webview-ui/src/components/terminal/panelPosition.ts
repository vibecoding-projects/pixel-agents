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
  TERMINAL_BAND_DEFAULT_HEIGHT_PX,
  TERMINAL_BAND_DEFAULT_WIDTH_PX,
  TERMINAL_BAND_MAX_HEIGHT_PX,
  TERMINAL_BAND_MAX_VIEWPORT_FRACTION,
  TERMINAL_BAND_MAX_WIDTH_PX,
  TERMINAL_BAND_MIN_HEIGHT_PX,
  TERMINAL_BAND_MIN_WIDTH_PX,
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

// ── Clamped pixel sizes (rail width, band height/width) ─────────
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

// ── Agent rail width (the DevTools-style rail/pane divider) ─────
const RAIL_WIDTH_KEY = 'pixel-agents.terminalRailWidth';

export function loadRailWidth(): number {
  return loadSize(
    RAIL_WIDTH_KEY,
    TERMINAL_RAIL_DEFAULT_WIDTH_PX,
    TERMINAL_RAIL_MIN_WIDTH_PX,
    TERMINAL_RAIL_MAX_WIDTH_PX,
  );
}

export function saveRailWidth(width: number): void {
  saveSize(RAIL_WIDTH_KEY, width, TERMINAL_RAIL_MIN_WIDTH_PX, TERMINAL_RAIL_MAX_WIDTH_PX);
}

// ── Terminal band size (edge-handle drag; height for bottom, width for sides) ─
// The band unmounts when hidden, so React state alone forgets the drag.
const BAND_HEIGHT_KEY = 'pixel-agents.terminalBandHeight';
const BAND_WIDTH_KEY = 'pixel-agents.terminalBandWidth';

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

/** Live width cap for a side-docked band: a fraction of the viewport width,
 *  never above the absolute ceiling, never below the minimum. */
export function bandMaxWidth(viewportWidth: number): number {
  return clamp(
    Math.floor(viewportWidth * TERMINAL_BAND_MAX_VIEWPORT_FRACTION),
    TERMINAL_BAND_MIN_WIDTH_PX,
    TERMINAL_BAND_MAX_WIDTH_PX,
  );
}

/** Live height cap for a bottom-docked band (same rule on the vertical axis). */
export function bandMaxHeight(viewportHeight: number): number {
  return clamp(
    Math.floor(viewportHeight * TERMINAL_BAND_MAX_VIEWPORT_FRACTION),
    TERMINAL_BAND_MIN_HEIGHT_PX,
    TERMINAL_BAND_MAX_HEIGHT_PX,
  );
}
