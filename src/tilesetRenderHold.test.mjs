import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installTilesetRenderHold } from './tilesetRenderHold.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
} from './renderGovernor.js';

/** Minimal Cesium.Event stand-in. */
function makeEvent() {
  const listeners = new Set();
  return {
    addEventListener: (fn) => listeners.add(fn),
    removeEventListener: (fn) => listeners.delete(fn),
    raise: (...args) => listeners.forEach((fn) => fn(...args)),
    size: () => listeners.size,
  };
}

function makeHarness() {
  const scene = {
    requestRenderMode: false,
    maximumRenderTimeChange: 0,
    requestRender() {},
  };
  const camera = { moveStart: makeEvent() };
  const viewer = { scene, camera };
  const tileset = {
    tilesLoaded: false,
    allTilesLoaded: makeEvent(),
    loadProgress: makeEvent(),
  };
  return { viewer, scene, camera, tileset };
}

const mode = () => getRenderGovernorDiagnostics().mode;

beforeEach(() => {
  _resetRenderGovernorForTest();
});

test('holds continuous render from install, before any tile event fires', () => {
  const { viewer, tileset } = makeHarness();
  installRenderGovernor(viewer);
  assert.equal(mode(), 'idle', 'governor starts idle with zero holds');

  installTilesetRenderHold(viewer, tileset);
  assert.equal(mode(), 'continuous', 'the stream hold flips the governor to continuous');
});

test('a single loadProgress zero reading does NOT release the hold', () => {
  const { viewer, tileset } = makeHarness();
  installRenderGovernor(viewer);
  installTilesetRenderHold(viewer, tileset);

  tileset.loadProgress.raise(0, 0);
  assert.equal(mode(), 'continuous', 'release never keys off a raw loadProgress zero');
});

test('release waits for allTilesLoaded + debounce + a still-loaded check', async () => {
  const { viewer, tileset } = makeHarness();
  installRenderGovernor(viewer);
  installTilesetRenderHold(viewer, tileset);

  tileset.tilesLoaded = true;
  tileset.allTilesLoaded.raise();
  assert.equal(mode(), 'continuous', 'still held during the debounce window');

  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(mode(), 'idle', 'settles to idle once the view stays loaded');
});

test('a camera move during the debounce window cancels the release', async () => {
  const { viewer, camera, tileset } = makeHarness();
  installRenderGovernor(viewer);
  installTilesetRenderHold(viewer, tileset);

  tileset.tilesLoaded = true;
  tileset.allTilesLoaded.raise();
  camera.moveStart.raise();

  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(mode(), 'continuous', 'the camera move re-armed the hold');
});

test('new tile activity after a settle re-holds continuous mode', async () => {
  const { viewer, tileset } = makeHarness();
  installRenderGovernor(viewer);
  installTilesetRenderHold(viewer, tileset);

  tileset.tilesLoaded = true;
  tileset.allTilesLoaded.raise();
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(mode(), 'idle');

  tileset.loadProgress.raise(4, 2);
  assert.equal(mode(), 'continuous', 'fresh pending/processing work wakes the hold');
});

test('teardown removes every listener and releases the hold', () => {
  const { viewer, camera, tileset } = makeHarness();
  installRenderGovernor(viewer);
  const teardown = installTilesetRenderHold(viewer, tileset);
  assert.equal(mode(), 'continuous');

  teardown();
  assert.equal(mode(), 'idle', 'teardown releases the stream hold');
  assert.equal(camera.moveStart.size(), 0);
  assert.equal(tileset.allTilesLoaded.size(), 0);
  assert.equal(tileset.loadProgress.size(), 0);
});

test('no viewer or no tileset is a safe no-op', () => {
  const { viewer } = makeHarness();
  installRenderGovernor(viewer);

  assert.doesNotThrow(() => installTilesetRenderHold(null, null));
  assert.doesNotThrow(() => installTilesetRenderHold(viewer, null));
  assert.doesNotThrow(() => installTilesetRenderHold(viewer, {}));
  assert.equal(mode(), 'idle', 'nothing held when there is nothing to stream');
});
