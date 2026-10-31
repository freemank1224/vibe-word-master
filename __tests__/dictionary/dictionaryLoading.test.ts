import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictionaryLookupCache, withinDeadline } from '../../services/dictionaryLookupCache.ts';
import { dictionaryBackfillFilters, forEachWithConcurrency, latestTestWordMeaning, missingDictionaryFields, needsDictionaryEnrichment } from '../../services/testPreparation.ts';
import type { WordEntry } from '../../types.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('active test displays the latest saved meaning without changing its queue entry', () => {
  const queued: WordEntry = {
    id: 'one', text: 'bank', timestamp: 1, sessionId: 'session', correct: false, tested: false,
    error_count: 0, best_time_ms: null, last_tested: null, phonetic: null, audio_url: null,
    definition_cn: null, definition_en: null,
  };
  const unrelated = { ...queued, id: 'two', definition_cn: '错误' };
  assert.equal(latestTestWordMeaning(queued, [unrelated]), queued);
  const repaired = { ...queued, definition_cn: '银行' };
  assert.equal(latestTestWordMeaning(queued, [unrelated, repaired]).definition_cn, '银行');
  const manuallyEdited = { ...repaired, definition_cn: '河岸' };
  assert.equal(latestTestWordMeaning(queued, [manuallyEdited]).definition_cn, '河岸');
  assert.equal(queued.definition_cn, null);
});

test('simultaneous public lookups share one request, with independent mutable results', async () => {
  const lookup = createDictionaryLookupCache<{ meanings: string[] }>();
  const pending = deferred<{ meanings: string[] }>();
  let calls = 0;
  const load = async () => { calls++; return pending.promise; };
  const first = lookup('en:run', load);
  const second = lookup('en:run', load);
  await tick();
  assert.equal(calls, 1);
  pending.resolve({ meanings: ['跑'] });
  const [a, b] = await Promise.all([first, second]);
  a!.meanings[0] = 'user selection';
  assert.deepEqual(b!.meanings, ['跑']);
  assert.deepEqual(await lookup('en:run', load), { meanings: ['跑'] });
  assert.equal(calls, 1);
});

test('negative cache expires quickly and LRU storage remains bounded', async () => {
  let now = 0;
  let calls = 0;
  const lookup = createDictionaryLookupCache<string>({ now: () => now, negativeTtlMs: 10, ttlMs: 100, maxEntries: 2 });
  const fail = async () => { calls++; return null; };
  await lookup('missing', fail);
  await lookup('missing', fail);
  assert.equal(calls, 1);
  now = 11;
  await lookup('missing', fail);
  assert.equal(calls, 2);
  await lookup('a', async () => 'A');
  await lookup('b', async () => 'B');
  await lookup('missing', fail);
  assert.equal(calls, 3);
});

test('a caller cancelling does not abort another caller sharing its lookup', async () => {
  const lookup = createDictionaryLookupCache<string>();
  const pending = deferred<string>();
  const firstController = new AbortController();
  let sharedSignal!: AbortSignal;
  const load = async (signal: AbortSignal) => { sharedSignal = signal; return pending.promise; };
  const first = lookup('shared', load, firstController.signal);
  const second = lookup('shared', load);
  await tick();
  firstController.abort();
  assert.equal(await first, null);
  assert.equal(sharedSignal.aborted, false);
  pending.resolve('meaning');
  assert.equal(await second, 'meaning');
});

test('last caller cancellation aborts the network and cannot poison a later retry', async () => {
  const lookup = createDictionaryLookupCache<string>();
  const cancelled = new AbortController();
  let sharedSignal!: AbortSignal;
  const first = lookup('retry', async signal => { sharedSignal = signal; return new Promise(() => {}); }, cancelled.signal);
  await tick();
  cancelled.abort();
  assert.equal(await first, null);
  assert.equal(sharedSignal.aborted, true);
  assert.equal(await lookup('retry', async () => 'recovered'), 'recovered');
});

test('global deadline returns even when a provider ignores abort', async () => {
  const lookup = createDictionaryLookupCache<string>({ timeoutMs: 20 });
  let signal!: AbortSignal;
  const started = performance.now();
  assert.equal(await lookup('hung', async input => { signal = input; return new Promise(() => {}); }), null);
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - started < 500);
});

test('provider deadline includes stalled response-body parsing and parent cancellation', async () => {
  let signal!: AbortSignal;
  await assert.rejects(withinDeadline(async input => {
    signal = input;
    await Promise.resolve({ ok: true });
    return new Promise(() => {});
  }, 20), { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  const parent = new AbortController();
  parent.abort();
  let requests = 0;
  await assert.rejects(withinDeadline(async () => { requests++; return true; }, 100, parent.signal), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('complete/selected meanings skip requests and late enrichment cannot overwrite a chosen definition', () => {
  assert.equal(needsDictionaryEnrichment({ definition_cn: '银行', selected_meaning_key: null }), false);
  assert.equal(needsDictionaryEnrichment({ definition_cn: null, selected_meaning_key: 'noun::bank' }), false);
  assert.equal(needsDictionaryEnrichment({ definition_cn: '暂无中文释义', selected_meaning_key: null }), true);
  const current = { definition_cn: '银行', definition_en: 'user explanation', phonetic: '/bæŋk/', selected_meaning_key: null };
  assert.deepEqual(missingDictionaryFields(current, { definition_cn: '河岸', definition_en: 'shore', phonetic: 'other' }), {});
  assert.deepEqual(missingDictionaryFields({ ...current, definition_cn: null, selected_meaning_key: 'chosen' }, { definition_cn: '河岸' }), {});
  assert.deepEqual(missingDictionaryFields({ ...current, definition_cn: '暂无释义' }, { definition_cn: '银行' }), { definition_cn: '银行' });
});

test('a saved failed lookup can be recovered without replacing real or unknown selections', () => {
  const failed = {
    definition_cn: '暂无中文释义', definition_en: null, phonetic: null,
    selected_meaning_key: 'na::暂无中文释义',
    meaning_options: [{ key: 'na::暂无中文释义', meaningZh: '暂无中文释义', sourceProvider: 'input-fallback' }],
  };
  assert.equal(needsDictionaryEnrichment(failed), true);
  assert.deepEqual(missingDictionaryFields(failed, { definition_cn: '控制器' }), {
    definition_cn: '控制器', selected_meaning_key: null,
  });
  assert.deepEqual(missingDictionaryFields(failed, { definition_en: 'a device' }), { definition_en: 'a device' });

  const real = { ...failed, meaning_options: [{ key: failed.selected_meaning_key, meaningZh: '控制器' }] };
  assert.equal(needsDictionaryEnrichment(real), false);
  assert.deepEqual(missingDictionaryFields(real, { definition_cn: '操纵者' }), {});
  const unknown = { ...failed, meaning_options: [] };
  assert.equal(needsDictionaryEnrichment(unknown), false);
  assert.deepEqual(missingDictionaryFields(unknown, { definition_cn: '操纵者' }), {});
});

test('invalid automated Chinese results are retried without overwriting real or user-selected meanings', () => {
  const failed = {
    definition_cn: 'sabertooth', definition_en: null, phonetic: null,
    selected_meaning_key: 'na::sabertooth',
    meaning_options: [{ key: 'na::sabertooth', meaningZh: 'sabertooth', sourceProvider: 'translation-fallback' }],
  };
  assert.equal(needsDictionaryEnrichment(failed), true);
  assert.deepEqual(missingDictionaryFields(failed, { definition_cn: 'sabertooth' }), {});
  assert.deepEqual(missingDictionaryFields(failed, { definition_cn: '剑齿虎' }), {
    definition_cn: '剑齿虎', selected_meaning_key: null,
  });
  const filters = dictionaryBackfillFilters(failed, { definition_cn: '剑齿虎', selected_meaning_key: null });
  assert.ok(filters.equals.some(([field, value]) => field === 'meaning_options' && value === JSON.stringify(failed.meaning_options)));
  assert.equal(needsDictionaryEnrichment({ ...failed, meaning_options: [{ ...failed.meaning_options[0], sourceProvider: 'user' }] }), false);
  assert.equal(needsDictionaryEnrichment({ ...failed, meaning_options: [{ ...failed.meaning_options[0], meaningZh: '剑齿虎' }] }), false);
  assert.equal(needsDictionaryEnrichment({ ...failed, meaning_options: [{ ...failed.meaning_options[0], sourceProvider: 'unknown' }] }), false);
  assert.equal(needsDictionaryEnrichment({ ...failed, selected_meaning_key: null }), true);
});

test('workers immediately refill freed slots without waiting for a slow batch member', async () => {
  const controller = new AbortController();
  const slow = deferred<void>();
  const visited: number[] = [];
  const work = forEachWithConcurrency([1, 2, 3, 4], 2, controller.signal, async value => {
    visited.push(value);
    if (value === 1) await slow.promise;
  });
  await tick();
  assert.deepEqual(visited, [1, 2, 3, 4]);
  slow.resolve();
  await work;
});

test('cancelled preparation starts no further resources', async () => {
  const controller = new AbortController();
  const visited: number[] = [];
  await forEachWithConcurrency([1, 2, 3], 1, controller.signal, async value => {
    visited.push(value);
    controller.abort();
  });
  assert.deepEqual(visited, [1]);
});


test('backfill guards preserve active legacy null/empty rows and the original language', () => {
  const fields = { definition_cn: null, definition_en: '', phonetic: null, selected_meaning_key: null };
  const filters = dictionaryBackfillFilters(fields, { definition_cn: '银行', definition_en: 'a bank' }, 'en');
  assert.deepEqual(filters, { or: [
    'deleted.eq.false,deleted.is.null',
    'language.eq.en,language.is.null,language.eq.""',
    'selected_meaning_key.is.null,selected_meaning_key.eq.""',
    'definition_cn.is.null,definition_cn.eq.""',
    'definition_en.is.null,definition_en.eq.""',
  ], equals: [] });
  const japanese = dictionaryBackfillFilters(fields, { definition_cn: '银行' }, 'ja');
  assert.deepEqual(japanese.equals, [['language', 'ja']]);
  assert.equal(japanese.or.some(filter => filter.startsWith('language.')), false);
});

test('backfill guard values never interpolate chosen text or language into raw filters', () => {
  const hostileValue = '\"),deleted.eq.true';
  const filters = dictionaryBackfillFilters({
    definition_cn: hostileValue, definition_en: null, phonetic: null, selected_meaning_key: hostileValue,
  }, { definition_cn: 'new' }, hostileValue);
  assert.deepEqual(filters.or, ['deleted.eq.false,deleted.is.null']);
  assert.deepEqual(filters.equals, [
    ['language', hostileValue], ['selected_meaning_key', hostileValue], ['definition_cn', hostileValue],
  ]);
});

test('backfill guards only admit the fixed metadata column whitelist', () => {
  const fields = { definition_cn: null, definition_en: null, phonetic: null, selected_meaning_key: null };
  const patch = { definition_cn: '银行', deleted: false };
  const filters = dictionaryBackfillFilters(fields, patch);
  assert.equal(filters.or.filter(filter => filter.startsWith('deleted.')).length, 1);
  assert.equal(filters.or.some(filter => filter.startsWith('phonetic.')), false);
  assert.equal(filters.or.some(filter => filter.startsWith('definition_en.')), false);
});
