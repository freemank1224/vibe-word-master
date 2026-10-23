import { test } from 'node:test';
import assert from 'node:assert/strict';

test('legacy audio migration validates entries and preserves newer cached audio', async () => {
  const now = Date.now();
  const values = new Map<string, string>([
    ['vibe_audio_cache', JSON.stringify({
      'sun-en': { url: '/current-sun.mp3', source: 'Current', timestamp: now, expiresAt: now + 60_000, accessCount: 0 },
    })],
    ['vibe_pronunciation_cache', JSON.stringify({
      sun: '/old-sun.mp3',
      moon: '/moon.mp3',
      star: { url: '/star.mp3', source: 'Legacy', timestamp: now - 1000, expiresAt: now + 60_000 },
      broken: { url: 42 },
      empty: null,
    })],
  ]);
  const storage: Storage = {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    const { audioCacheManager } = await import('../audioCache.ts');
    assert.equal(audioCacheManager.get('sun'), '/current-sun.mp3');
    assert.equal(audioCacheManager.get('moon'), '/moon.mp3');
    assert.equal(audioCacheManager.get('star'), '/star.mp3');
    assert.equal(audioCacheManager.get('broken'), null);
    assert.equal(audioCacheManager.get('empty'), null);
    assert.equal(audioCacheManager.getStats().totalEntries, 3);
    assert.equal(storage.getItem('vibe_pronunciation_cache'), null);
    const saved: Record<string, { source: string }> = JSON.parse(storage.getItem('vibe_audio_cache')!);
    assert.equal(saved['star-en'].source, 'Legacy');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
