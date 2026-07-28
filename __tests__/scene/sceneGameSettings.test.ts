/**
 * Tests for the Scene Game client-side settings (Admin Console / "~" panel).
 * After the §10 security refactor, persisted fields are NON-SENSITIVE only:
 *   • `visionEnabled`     — ③ vision-refinement toggle
 *   • `directorProvider`  — which server-side director config to use
 *                           ('default' = Minimax-m3, 'aliyun' = Tongyi qwen-max)
 * All LLM keys live server-side; the selector is just a string.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- minimal localStorage shim on a fake window ---
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
(globalThis as any).window = { localStorage: localStorageShim };

const { SceneGameSettings } = await import('../../services/sceneGameSettings.ts');

beforeEach(() => store.clear());

test('load() returns visionEnabled=false by default when nothing stored', () => {
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, false);
});

test('save() then load() round-trips visionEnabled', () => {
  SceneGameSettings.save({ visionEnabled: true, directorProvider: 'default' });
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, true);
});

test('isVisionEnabled() reflects the persisted toggle', () => {
  SceneGameSettings.save({ visionEnabled: true, directorProvider: 'default' });
  assert.equal(SceneGameSettings.isVisionEnabled(), true);
  SceneGameSettings.save({ visionEnabled: false, directorProvider: 'default' });
  assert.equal(SceneGameSettings.isVisionEnabled(), false);
});

test('a stray legacy value does not affect default load', () => {
  store.set('vibe-word-scene-llm-design', '{"baseUrl":"u","apiKey":"k"}');
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, false);
});

test('clear() resets the toggle to false', () => {
  SceneGameSettings.save({ visionEnabled: true, directorProvider: 'aliyun' });
  SceneGameSettings.clear();
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, false);
  assert.equal(SceneGameSettings.isVisionEnabled(), false);
});

// --- directorProvider (non-sensitive selector, extends §10) ---

test('load() returns directorProvider=default by default when nothing stored', () => {
  const s = SceneGameSettings.load();
  assert.equal(s.directorProvider, 'default');
});

test('getDirectorProvider() returns "default" initially', () => {
  assert.equal(SceneGameSettings.getDirectorProvider(), 'default');
});

test('setDirectorProvider("aliyun") round-trips through load()', () => {
  SceneGameSettings.setDirectorProvider('aliyun');
  assert.equal(SceneGameSettings.getDirectorProvider(), 'aliyun');
  assert.equal(SceneGameSettings.load().directorProvider, 'aliyun');
});

test('save() persists directorProvider alongside visionEnabled', () => {
  SceneGameSettings.save({ visionEnabled: true, directorProvider: 'aliyun' });
  const s = SceneGameSettings.load();
  assert.equal(s.directorProvider, 'aliyun');
  assert.equal(s.visionEnabled, true);
});

test('unknown / garbage persisted values fall back to "default"', () => {
  store.set('vibe-word-scene-llm-director-provider', 'minimax');
  assert.equal(SceneGameSettings.load().directorProvider, 'default');
  store.set('vibe-word-scene-llm-director-provider', '');
  assert.equal(SceneGameSettings.load().directorProvider, 'default');
  store.set('vibe-word-scene-llm-director-provider', 'ALIYUN'); // case-insensitive
  assert.equal(SceneGameSettings.load().directorProvider, 'aliyun');
});

test('clear() resets directorProvider to "default"', () => {
  SceneGameSettings.setDirectorProvider('aliyun');
  SceneGameSettings.clear();
  assert.equal(SceneGameSettings.getDirectorProvider(), 'default');
});
