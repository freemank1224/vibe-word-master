import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLazyResource } from '../../utils/lazyResource.ts';

test('deferred resources start only on demand and share concurrent and later requests', async () => {
  let loads = 0;
  const resource = { ready: true };
  const load = createLazyResource(async () => { loads += 1; return resource; });
  assert.equal(loads, 0);
  const first = load();
  assert.equal(load(), first);
  assert.equal(await first, resource);
  assert.equal(await load(), resource);
  assert.equal(loads, 1);
});

test('a failed deferred import is not cached and can recover after the network returns', async () => {
  let loads = 0;
  const load = createLazyResource(async () => {
    loads += 1;
    if (loads === 1) throw new Error('network unavailable');
    return 'ready';
  });
  await assert.rejects(load(), /network unavailable/);
  assert.equal(await load(), 'ready');
  assert.equal(loads, 2);
});
