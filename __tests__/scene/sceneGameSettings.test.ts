/**
 * Tests for the Scene Game client-side settings (Admin Console / "~" panel).
 * After the §10 security refactor, the only persisted field is the
 * non-sensitive `visionEnabled` toggle. All LLM keys live server-side.
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
  SceneGameSettings.save({ visionEnabled: true });
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, true);
});

test('isVisionEnabled() reflects the persisted toggle', () => {
  SceneGameSettings.save({ visionEnabled: true });
  assert.equal(SceneGameSettings.isVisionEnabled(), true);
  SceneGameSettings.save({ visionEnabled: false });
  assert.equal(SceneGameSettings.isVisionEnabled(), false);
});

test('a stray legacy value does not affect default load', () => {
  store.set('vibe-word-scene-llm-design', '{"baseUrl":"u","apiKey":"k"}');
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, false);
});

test('clear() resets the toggle to false', () => {
  SceneGameSettings.save({ visionEnabled: true });
  SceneGameSettings.clear();
  const s = SceneGameSettings.load();
  assert.equal(s.visionEnabled, false);
  assert.equal(SceneGameSettings.isVisionEnabled(), false);
});
