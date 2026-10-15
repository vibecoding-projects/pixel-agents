/**
 * World coordinates → screen coordinates, in one place.
 *
 * The office is drawn by centering the map in the canvas and then applying the
 * pan, both snapped to whole device pixels so sprites stay on the pixel grid.
 * That formula was reproduced in the renderer and in each DOM overlay that
 * floats something above a character; a copy that rounds differently puts the
 * overlay a pixel off the sprite it is labelling, which is invisible in review
 * and obvious on screen.
 *
 * Deliberately free of DOM access — `dpr` is passed in, not read from
 * `window`. Reading the environment belongs at the component boundary; a state
 * or math module that reaches for `window` drags the DOM into every module
 * graph that imports it.
 */

import { TILE_SIZE } from './types.js';

/** A fractional zoom level (3.5x) is drawn at the next whole level (4x, so
 *  every sprite pixel is still a whole number of device pixels and the art
 *  stays crisp) and the canvas is scaled DOWN by `scale` (0.875) to the
 *  requested size. Whole levels scale by 1 and are untouched. */
export function splitZoom(zoom: number): { renderZoom: number; scale: number } {
  const renderZoom = Math.max(1, Math.ceil(zoom));
  return { renderZoom, scale: zoom / renderZoom };
}

/** Backing-store size (device px) of a canvas that is scaled by `scale` to
 *  cover `cssSize` CSS px at `dpr`. Shared by the canvas resize and the
 *  overlay projection so both round the same way. */
export function scaledCanvasSize(cssSize: number, dpr: number, scale: number): number {
  return Math.round((cssSize * dpr) / scale);
}

/** Device-pixel offset of the map's top-left corner inside the canvas.
 *  This is the renderer's own frame of reference — overlays go through
 *  {@link overlayProjection} instead of calling this directly. */
export function mapOffset(
  canvasWidth: number,
  canvasHeight: number,
  cols: number,
  rows: number,
  zoom: number,
  panX: number,
  panY: number,
): { offsetX: number; offsetY: number } {
  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  return {
    offsetX: Math.floor((canvasWidth - mapW) / 2) + Math.round(panX),
    offsetY: Math.floor((canvasHeight - mapH) / 2) + Math.round(panY),
  };
}

/** Projects world points into CSS pixels within the overlay container that
 *  sits on top of the canvas. */
export interface OverlayProjection {
  toScreenX(worldX: number): number;
  toScreenY(worldY: number): number;
  /** Container size in world units — what the viewport currently covers.
   *  Used to cap overlay offsets against the visible area. */
  readonly viewportWorldWidth: number;
  readonly viewportWorldHeight: number;
  /** CSS px → world units, for sizing overlay geometry in world terms. */
  toWorldLength(cssPx: number): number;
}

export function overlayProjection(
  layout: { cols: number; rows: number },
  containerRect: { width: number; height: number },
  zoom: number,
  pan: { x: number; y: number },
  dpr: number,
): OverlayProjection {
  // The canvas is drawn at renderZoom and scaled by `scale` on screen, so a
  // device pixel of the backing store is scale/dpr CSS px in the container.
  const { renderZoom, scale } = splitZoom(zoom);
  const canvasW = scaledCanvasSize(containerRect.width, dpr, scale);
  const canvasH = scaledCanvasSize(containerRect.height, dpr, scale);
  const { offsetX, offsetY } = mapOffset(
    canvasW,
    canvasH,
    layout.cols,
    layout.rows,
    renderZoom,
    pan.x,
    pan.y,
  );
  const cssPerDevice = scale / dpr;
  return {
    toScreenX: (worldX) => (offsetX + worldX * renderZoom) * cssPerDevice,
    toScreenY: (worldY) => (offsetY + worldY * renderZoom) * cssPerDevice,
    viewportWorldWidth: canvasW / renderZoom,
    viewportWorldHeight: canvasH / renderZoom,
    toWorldLength: (cssPx) => cssPx / (renderZoom * cssPerDevice),
  };
}
