import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIconFont, revealApplication } from '../../services/startup.ts';

test('React readiness removes the blocking loader without inspecting fonts or images', () => {
  const marks: string[] = [];
  const dataset: Record<string, string> = {};
  let removed = 0;
  const doc = {
    documentElement: { dataset },
    getElementById: (id: string) => id === 'loading-screen' ? { remove: () => { removed += 1; } } : null,
    defaultView: { performance: { mark: (name: string) => marks.push(name) } },
    get fonts() { throw new Error('Fonts cannot gate application readiness'); },
  } as unknown as Document;

  revealApplication(doc);
  revealApplication(doc); // React Strict Mode repeats the initial effect in development.
  assert.equal(dataset.appReady, 'true');
  assert.equal(removed, 1);
  assert.deepEqual(marks, ['vocab-app-ready']);
});

function fontDocument(load: () => Promise<FontFace[]>) {
  const classes = new Set<string>();
  const doc = {
    documentElement: { classList: { add: (name: string) => classes.add(name) } },
    fonts: { load },
  } as unknown as Document;
  return { doc, classes };
}

const flushPromises = () => new Promise<void>(resolve => setImmediate(resolve));

test('a missing font face does not expose fallback ligature text', async () => {
  const fixture = fontDocument(async () => []);
  prepareIconFont(fixture.doc);
  await flushPromises();
  assert.equal(fixture.classes.has('symbols-ready'), false);
});

test('local icons become visible as soon as their own font is loaded', async () => {
  const fixture = fontDocument(async () => [{ status: 'loaded' } as FontFace]);
  prepareIconFont(fixture.doc);
  await flushPromises();
  assert.equal(fixture.classes.has('symbols-ready'), true);
});

test('failed font requests leave icons safely hidden and do not reject application startup', async () => {
  const fixture = fontDocument(async () => { throw new Error('Font CDN unavailable'); });
  assert.doesNotThrow(() => prepareIconFont(fixture.doc));
  await flushPromises();
  assert.equal(fixture.classes.has('symbols-ready'), false);
});

test('browsers without the Font Loading API retain the nonblocking fallback', () => {
  assert.doesNotThrow(() => prepareIconFont({} as Document));
});
