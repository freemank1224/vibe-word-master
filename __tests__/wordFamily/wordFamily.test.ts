/**
 * Unit tests for the local word-family detector.
 *
 * Run:  node --test __tests__/wordFamily/wordFamily.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWordFamilyDetector, detectWordFamily } from '../../services/wordFamilyService.ts';

test('irregular verb — any principal form maps to the full family', async () => {
  for (const input of ['went', 'gone', 'go', 'Go', 'WENT']) {
    const r = await detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.equal(r?.reason, 'irregular-verb');
    assert.equal(r?.headword, 'go');
    assert.deepEqual(r?.forms, ['go', 'went', 'gone']);
  }
});

test('irregular verb — 3rd-person "-s" form resolved via singularize (takes → take)', async () => {
  for (const input of ['takes', 'goes']) {
    const r = await detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true, `${input} should be a family member`);
    assert.equal(r?.reason, 'irregular-verb');
  }
  const take = await detectWordFamily('takes');
  assert.equal(take?.headword, 'take');
  assert.deepEqual(take?.forms, ['take', 'took', 'taken']);
});

test('irregular verb — past-participle == base collapses duplicates (run/ran)', async () => {
  for (const input of ['run', 'ran']) {
    const r = await detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.deepEqual(r?.forms, ['run', 'ran'], 'V3==V1 should dedupe to two forms');
  }
});

test('regular verb — only "-ed" forms trigger, surfacing the lemma', async () => {
  for (const [input, lemma] of [['walked', 'walk'], ['played', 'play'], ['stopped', 'stop']] as const) {
    const r = await detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.equal(r?.reason, 'regular-verb');
    assert.equal(r?.headword, lemma);
    assert.deepEqual(r?.forms, [lemma, input]);
  }
});

test('plural noun — plural form surfaces the singular', async () => {
  for (const [input, singular] of [['shoes', 'shoe'], ['children', 'child'], ['cats', 'cat']] as const) {
    const r = await detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.equal(r?.reason, 'plural-noun');
    assert.equal(r?.headword, singular);
    assert.deepEqual(r?.forms, [singular, input]);
  }
});

test('does NOT fire on regular base forms (avoid prompting on every entry)', async () => {
  // Singular nouns / regular-verb bases read as noise — no family prompt.
  for (const input of ['cat', 'shoe', 'walk', 'play', 'the', 'beautiful', 'happy']) {
    const r = await detectWordFamily(input);
    assert.equal(r?.isFamilyMember, false, `${input} should not trigger a family`);
  }
});

test('"goes" is treated as a verb (not a plural noun) — POS priority', async () => {
  const r = await detectWordFamily('goes');
  assert.equal(r?.reason, 'irregular-verb');
  assert.equal(r?.headword, 'go');
});

test('multi-word / empty / whitespace inputs return null', async () => {
  assert.equal(await detectWordFamily(''), null);
  assert.equal(await detectWordFamily('   '), null);
  assert.equal(await detectWordFamily('take off'), null);
  assert.equal(await detectWordFamily('take  off'), null);
});

test('irregular verbs, plural nouns, ordinary words and phrases never load the verb dictionary', async () => {
  let loads = 0;
  const detect = createWordFamilyDetector(async () => {
    loads += 1;
    throw new Error('the verb chunk should not be requested');
  });
  assert.deepEqual(await detect('went'), { isFamilyMember: true, headword: 'go', forms: ['go', 'went', 'gone'], reason: 'irregular-verb' });
  assert.deepEqual(await detect('shoes'), { isFamilyMember: true, headword: 'shoe', forms: ['shoe', 'shoes'], reason: 'plural-noun' });
  assert.equal((await detect('learned'))?.reason, 'irregular-verb', 'an -ed ending already in the irregular table stays on the light path');
  assert.deepEqual(await detect('cat'), { isFamilyMember: false });
  assert.equal(await detect('take off'), null);
  assert.equal(await detect(''), null);
  assert.equal(loads, 0);
});

test('only unresolved -ed forms await one shared verb dictionary and preserve their lemma results', async () => {
  let loads = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const detect = createWordFamilyDetector(async () => {
    loads += 1;
    await ready;
    return word => ({ walked: 'walk', played: 'play' }[word] || word);
  });
  let settled = false;
  const walked = detect('walked').then(result => { settled = true; return result; });
  const played = detect('played');
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(loads, 1);
  release();
  assert.deepEqual(await walked, { isFamilyMember: true, headword: 'walk', forms: ['walk', 'walked'], reason: 'regular-verb' });
  assert.deepEqual(await played, { isFamilyMember: true, headword: 'play', forms: ['play', 'played'], reason: 'regular-verb' });
  assert.deepEqual(await detect('red'), { isFamilyMember: false });
  assert.equal(loads, 1);
});

test('a failed optional verb chunk skips the family prompt and can retry on a later input', async (context) => {
  context.mock.method(console, 'warn', () => {});
  let loads = 0;
  const detect = createWordFamilyDetector(async () => {
    loads += 1;
    if (loads === 1) throw new Error('offline');
    return () => 'walk';
  });
  assert.equal(await detect('walked'), null);
  assert.equal((await detect('walked'))?.headword, 'walk');
  assert.equal(loads, 2);
});
