/**
 * TDD tests for the Scene Game LLM settings module (Admin Console / "~" panel).
 * Uses a minimal in-memory localStorage shim since node:test has no `window`.
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

test('load() returns empty defaults when nothing stored', () => {
  const s = SceneGameSettings.load();
  assert.equal(s.design.baseUrl, '');
  assert.equal(s.design.apiKey, '');
  assert.equal(s.vision.model, '');
  assert.equal(s.visionEnabled, false);
});

test('save() then load() round-trips all fields', () => {
  SceneGameSettings.save({
    design: { baseUrl: 'https://gw.example.com', apiKey: 'sk-1', model: 'gpt-4o' },
    vision: { baseUrl: 'https://gw.example.com', apiKey: 'sk-2', model: 'gpt-4o' },
    visionEnabled: true,
  });
  const s = SceneGameSettings.load();
  assert.equal(s.design.baseUrl, 'https://gw.example.com');
  assert.equal(s.design.apiKey, 'sk-1');
  assert.equal(s.design.model, 'gpt-4o');
  assert.equal(s.vision.apiKey, 'sk-2');
  assert.equal(s.visionEnabled, true);
});

test('corrupted stored JSON degrades gracefully to empty endpoint', () => {
  store.set('vibe-word-scene-llm-design', '{not json');
  const s = SceneGameSettings.load();
  assert.equal(s.design.baseUrl, '');
  assert.equal(s.design.apiKey, '');
});

test('toRequestPayload includes design only when configured', () => {
  SceneGameSettings.save({
    design: { baseUrl: 'u', apiKey: 'k', model: 'm' },
    vision: { baseUrl: '', apiKey: '', model: '' },
    visionEnabled: false,
  });
  const p = SceneGameSettings.toRequestPayload();
  assert.ok(p.design, 'design present');
  assert.equal(p.design!.apiKey, 'k');
  assert.equal(p.vision, undefined);
  assert.equal(p.visionEnabled, false);
});

test('toRequestPayload carries visionEnabled flag independently of config presence', () => {
  SceneGameSettings.save({
    design: { baseUrl: '', apiKey: '', model: '' },
    vision: { baseUrl: '', apiKey: '', model: '' },
    visionEnabled: true,
  });
  const p = SceneGameSettings.toRequestPayload();
  assert.equal(p.design, undefined);
  assert.equal(p.vision, undefined);
  assert.equal(p.visionEnabled, true);
});

test('clear() wipes all keys', () => {
  SceneGameSettings.save({
    design: { baseUrl: 'u', apiKey: 'k', model: 'm' },
    vision: { baseUrl: 'u2', apiKey: 'k2', model: 'm2' },
    visionEnabled: true,
  });
  SceneGameSettings.clear();
  const s = SceneGameSettings.load();
  assert.equal(s.design.baseUrl, '');
  assert.equal(s.vision.baseUrl, '');
  assert.equal(s.visionEnabled, false);
});
