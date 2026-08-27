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
