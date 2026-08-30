/**
 * 3D-tileset streaming hold — companion to the idle render governor.
 *
 * The governor (see renderGovernor.js) flips the scene into Cesium's
 * `requestRenderMode` whenever zero continuous-render holds are registered,
 * and sets `maximumRenderTimeChange = Infinity` so nothing but camera input
 * or an explicit request can wake the loop.
 *
 * Its docstring assumes Cesium "auto-renders on ... tile loads". That does
 * NOT hold for Google Photorealistic 3D Tiles during bulk streaming: on a
 * cold load with no data layers enabled, the governor goes idle while the
 * tileset still has thousands of tiles to fetch. The loop stops,
 * `loadProgress` stops firing, tile requests flatline, and the map is left
 * as a single coarse blurry tile that only refines when the camera is
 * nudged — then freezes again. (Diagnosed 2026-08-29 on the hosted lean
 * build: root.json 200, zero tile failures, WebGL fine, Google credit
 * untouched — purely render-loop starvation.)
 *
 * The fix: hold the scene in continuous-render mode whenever the tileset
 * *could* be streaming — from install, through every camera move — and only
 * let go a few seconds after Cesium reports the current view fully loaded.
 * Release decisions never depend on a single `loadProgress` zero reading
 * (which races the traversal and can deadlock idle mode); they depend on
 * the `allTilesLoaded` event plus a debounce. A genuinely parked camera
 * over a fully-loaded tileset still settles to idle, preserving the
 * governor's power win.
 */

import { holdContinuousRender, releaseContinuousRender } from './renderGovernor.js';

const OWNER = 'tiles-3d-stream';
/** Keep rendering this long after the view reports fully loaded, to ride out refinement lulls. */
const SETTLE_DEBOUNCE_MS = 3000;

/**
 * Keep the scene continuously rendering while `tileset` streams tiles.
 *
 * @param {import('cesium').Viewer} viewer
 * @param {import('cesium').Cesium3DTileset | null | undefined} tileset
 * @returns {() => void} teardown — removes listeners and releases the hold
 */
export function installTilesetRenderHold(viewer, tileset) {
  if (!viewer?.camera || !tileset || typeof tileset.allTilesLoaded?.addEventListener !== 'function') {
    return () => {};
  }

  let held = false;
  let releaseTimer = null;

  const clearReleaseTimer = () => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };

  const hold = () => {
    clearReleaseTimer();
    if (held) return;
    held = true;
    holdContinuousRender(OWNER);
  };

  const releaseNow = () => {
    clearReleaseTimer();
    if (!held) return;
    held = false;
    releaseContinuousRender(OWNER);
  };

  const releaseAfterSettle = () => {
    if (!held || releaseTimer !== null) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      // Only stand down if the view really is still loaded — a camera move
      // during the debounce window re-holds and cancels this path anyway.
      if (tileset.tilesLoaded) releaseNow();
    }, SETTLE_DEBOUNCE_MS);
  };

  // Stream is in flight the moment we're installed (cold boot) — hold now.
  hold();

  // Any camera motion (user drag/zoom OR a programmatic flyTo) will queue a
  // fresh batch of tiles. Grab the hold on the way in; allTilesLoaded winds
  // it back down once the new view is resolved.
  const onMoveStart = () => hold();
  viewer.camera.moveStart.addEventListener(onMoveStart);

  // Fires each time the request/processing queue fully drains for the
  // current camera. Debounced so brief gaps between LOD batches don't drop
  // us to idle and re-stall.
  const onAllLoaded = () => releaseAfterSettle();
  tileset.allTilesLoaded.addEventListener(onAllLoaded);

  // New activity discovered on a rendered frame — cancel any pending release.
  const onProgress = (pending, processing) => {
    if ((pending | 0) + (processing | 0) > 0) hold();
  };
  tileset.loadProgress.addEventListener(onProgress);

  return () => {
    clearReleaseTimer();
    viewer.camera.moveStart.removeEventListener(onMoveStart);
    tileset.allTilesLoaded.removeEventListener(onAllLoaded);
    tileset.loadProgress.removeEventListener(onProgress);
    releaseNow();
  };
}
