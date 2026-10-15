/**
 * Fractional zoom: the renderer always draws at the next whole zoom
 * (crisp pixel art) and the canvas is scaled down to the requested level.
 * overlayProjection must land DOM overlays on the scaled picture.
 *
 * Run with: npm run test:webview -- test/projection.test.ts
 */
import { describe, expect, it } from 'vitest';

import { overlayProjection, splitZoom } from '../src/office/projection.js';

describe('splitZoom', () => {
  it('whole zoom renders as itself with no scaling', () => {
    expect(splitZoom(3)).toEqual({ renderZoom: 3, scale: 1 });
  });
  it('a half step renders at the next whole zoom scaled down', () => {
    expect(splitZoom(3.5)).toEqual({ renderZoom: 4, scale: 0.875 });
    expect(splitZoom(1.5)).toEqual({ renderZoom: 2, scale: 0.75 });
  });
});

describe('overlayProjection with fractional zoom', () => {
  const layout = { cols: 10, rows: 10 };
  const rect = { width: 800, height: 600 };

  it('matches the whole-zoom projection exactly at integer zoom', () => {
    const p = overlayProjection(layout, rect, 2, { x: 0, y: 0 }, 1);
    // map is 160 world px = 320 device px wide, centered in 800: offset 240
    expect(p.toScreenX(0)).toBe(240);
    expect(p.toScreenX(10)).toBe(260);
    expect(p.viewportWorldWidth).toBe(400);
  });

  it('places world points on the scaled picture at a half step', () => {
    // 3.5x: drawn at 4x on a canvas 800/0.875 CSS px wide, then scaled by 0.875.
    const p = overlayProjection(layout, rect, 3.5, { x: 0, y: 0 }, 1);
    // map at 4x = 640 device px; canvas = round(800/0.875) = 914 → offset floor(137) = 137
    // on screen: 137 * 0.875 = 119.875
    expect(p.toScreenX(0)).toBeCloseTo(119.875, 5);
    // 10 world px further = 40 device px = 35 CSS px on screen
    expect(p.toScreenX(10) - p.toScreenX(0)).toBeCloseTo(35, 5);
    // The viewport covers ~800 CSS px / 3.5 world px per CSS px (the backing
    // store rounds to whole device pixels, so allow half a world pixel).
    expect(Math.abs(p.viewportWorldWidth - 800 / 3.5)).toBeLessThan(0.5);
    expect(p.toWorldLength(35)).toBeCloseTo(10, 5);
  });

  it('honours dpr together with the scale', () => {
    const p = overlayProjection(layout, rect, 3.5, { x: 0, y: 0 }, 2);
    expect(p.toScreenX(10) - p.toScreenX(0)).toBeCloseTo(17.5, 5);
  });
});
