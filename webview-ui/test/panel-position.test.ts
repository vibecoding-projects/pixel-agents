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
  bandMaxHeight,
  bandMaxWidth,
  loadBandHeight,
  loadBandWidth,
  loadPanelOpen,
  loadPanelPosition,
  loadRailWidth,
  saveBandHeight,
  saveBandWidth,
  savePanelOpen,
  savePanelPosition,
  saveRailWidth,
} from '../src/components/terminal/panelPosition.js';
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

describe('panelOpen persistence', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults to closed with nothing stored', () => {
    expect(loadPanelOpen()).toBe(false);
  });

  it('round-trips open and closed', () => {
    savePanelOpen(true);
    expect(loadPanelOpen()).toBe(true);
    savePanelOpen(false);
    expect(loadPanelOpen()).toBe(false);
  });

  it('falls back to closed on a corrupt stored value', () => {
    store['pixel-agents.terminalOpen'] = 'maybe';
    expect(loadPanelOpen()).toBe(false);
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
    expect(loadPanelOpen()).toBe(false);
    expect(() => savePanelOpen(true)).not.toThrow();
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

describe('terminal band size persistence', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults with nothing stored', () => {
    expect(loadBandHeight()).toBe(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_DEFAULT_WIDTH_PX);
  });

  it('round-trips height and width independently', () => {
    saveBandHeight(TERMINAL_BAND_MIN_HEIGHT_PX + 17);
    saveBandWidth(TERMINAL_BAND_MIN_WIDTH_PX + 23);
    expect(loadBandHeight()).toBe(TERMINAL_BAND_MIN_HEIGHT_PX + 17);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_MIN_WIDTH_PX + 23);
  });

  it('clamps on save and on load', () => {
    saveBandHeight(TERMINAL_BAND_MAX_HEIGHT_PX + 500);
    expect(loadBandHeight()).toBe(TERMINAL_BAND_MAX_HEIGHT_PX);
    store['pixel-agents.terminalBandWidth'] = String(TERMINAL_BAND_MIN_WIDTH_PX - 1);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_MIN_WIDTH_PX);
    store['pixel-agents.terminalBandHeight'] = String(TERMINAL_BAND_MAX_HEIGHT_PX + 1);
    expect(loadBandHeight()).toBe(TERMINAL_BAND_MAX_HEIGHT_PX);
  });

  it('falls back to the default on garbage', () => {
    store['pixel-agents.terminalBandHeight'] = 'tall';
    store['pixel-agents.terminalBandWidth'] = '-4';
    expect(loadBandHeight()).toBe(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_DEFAULT_WIDTH_PX);
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
    expect(() => saveBandHeight(300)).not.toThrow();
    expect(loadBandHeight()).toBe(TERMINAL_BAND_DEFAULT_HEIGHT_PX);
    expect(loadBandWidth()).toBe(TERMINAL_BAND_DEFAULT_WIDTH_PX);
  });
});

describe('terminal band viewport cap', () => {
  it('caps at a fraction of the viewport, never above the absolute ceiling', () => {
    expect(bandMaxWidth(1000)).toBe(Math.floor(1000 * TERMINAL_BAND_MAX_VIEWPORT_FRACTION));
    expect(bandMaxHeight(800)).toBe(Math.floor(800 * TERMINAL_BAND_MAX_VIEWPORT_FRACTION));
    expect(bandMaxWidth(100_000)).toBe(TERMINAL_BAND_MAX_WIDTH_PX);
    expect(bandMaxHeight(100_000)).toBe(TERMINAL_BAND_MAX_HEIGHT_PX);
  });

  it('never drops below the minimum size on a tiny viewport', () => {
    expect(bandMaxWidth(10)).toBe(TERMINAL_BAND_MIN_WIDTH_PX);
    expect(bandMaxHeight(10)).toBe(TERMINAL_BAND_MIN_HEIGHT_PX);
  });

  it('the absolute ceilings are large enough for a wide monitor', () => {
    expect(TERMINAL_BAND_MAX_WIDTH_PX).toBeGreaterThanOrEqual(2400);
    expect(TERMINAL_BAND_MAX_HEIGHT_PX).toBeGreaterThanOrEqual(1600);
  });
});
