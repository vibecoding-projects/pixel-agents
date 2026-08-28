/**
 * Unit tests for the terminal-band dock position persistence
 * (`loadPanelPosition` / `savePanelPosition`). Webview-local by design:
 * the dock side is a per-browser preference of the standalone surface, so it
 * lives in localStorage (v2's panelPersistence pattern), not in the
 * per-namespace server config like Settings checkboxes.
 *
 * Run with: npm run test:webview -- test/panel-position.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadPanelPosition,
  loadRailWidth,
  savePanelPosition,
  saveRailWidth,
} from '../src/components/terminal/panelPosition.js';
import {
  TERMINAL_RAIL_DEFAULT_WIDTH_PX,
  TERMINAL_RAIL_MAX_WIDTH_PX,
  TERMINAL_RAIL_MIN_WIDTH_PX,
} from '../src/constants.js';

function stubLocalStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  return store;
}

describe('panelPosition persistence', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults to bottom with nothing stored', () => {
    expect(loadPanelPosition()).toBe('bottom');
  });

  it('round-trips left and right', () => {
    savePanelPosition('left');
    expect(loadPanelPosition()).toBe('left');
    savePanelPosition('right');
    expect(loadPanelPosition()).toBe('right');
  });

  it('falls back to bottom on a corrupt stored value', () => {
    store['pixel-agents.panelPosition'] = 'sideways';
    expect(loadPanelPosition()).toBe('bottom');
  });

  it('survives a missing/throwing localStorage (returns the default)', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadPanelPosition()).toBe('bottom');
    expect(() => savePanelPosition('left')).not.toThrow();
  });
});

describe('railWidth persistence', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults with nothing stored', () => {
    expect(loadRailWidth()).toBe(TERMINAL_RAIL_DEFAULT_WIDTH_PX);
  });

  it('round-trips a dragged width', () => {
    saveRailWidth(200);
    expect(loadRailWidth()).toBe(200);
  });

  it('clamps stored values into the min/max range', () => {
    store['pixel-agents.terminalRailWidth'] = '10';
    expect(loadRailWidth()).toBe(TERMINAL_RAIL_MIN_WIDTH_PX);
    store['pixel-agents.terminalRailWidth'] = '9999';
    expect(loadRailWidth()).toBe(TERMINAL_RAIL_MAX_WIDTH_PX);
  });

  it('falls back to the default on a corrupt stored value', () => {
    store['pixel-agents.terminalRailWidth'] = 'wide';
    expect(loadRailWidth()).toBe(TERMINAL_RAIL_DEFAULT_WIDTH_PX);
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
    expect(loadRailWidth()).toBe(TERMINAL_RAIL_DEFAULT_WIDTH_PX);
    expect(() => saveRailWidth(200)).not.toThrow();
  });
});
