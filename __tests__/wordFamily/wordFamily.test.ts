/**
 * Unit tests for the local word-family detector.
 *
 * Run:  node --test __tests__/wordFamily/wordFamily.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWordFamily } from '../../services/wordFamilyService.ts';

test('irregular verb — any principal form maps to the full family', () => {
  for (const input of ['went', 'gone', 'go', 'Go', 'WENT']) {
    const r = detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.equal(r?.reason, 'irregular-verb');
    assert.equal(r?.headword, 'go');
    assert.deepEqual(r?.forms, ['go', 'went', 'gone']);
  }
});

test('irregular verb — 3rd-person "-s" form resolved via singularize (takes → take)', () => {
  for (const input of ['takes', 'goes']) {
    const r = detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true, `${input} should be a family member`);
    assert.equal(r?.reason, 'irregular-verb');
  }
  const take = detectWordFamily('takes');
  assert.equal(take?.headword, 'take');
  assert.deepEqual(take?.forms, ['take', 'took', 'taken']);
});

test('irregular verb — past-participle == base collapses duplicates (run/ran)', () => {
  for (const input of ['run', 'ran']) {
    const r = detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.deepEqual(r?.forms, ['run', 'ran'], 'V3==V1 should dedupe to two forms');
  }
});

test('regular verb — only "-ed" forms trigger, surfacing the lemma', () => {
  for (const [input, lemma] of [['walked', 'walk'], ['played', 'play'], ['stopped', 'stop']] as const) {
    const r = detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.equal(r?.reason, 'regular-verb');
    assert.equal(r?.headword, lemma);
    assert.deepEqual(r?.forms, [lemma, input]);
  }
});

test('plural noun — plural form surfaces the singular', () => {
  for (const [input, singular] of [['shoes', 'shoe'], ['children', 'child'], ['cats', 'cat']] as const) {
    const r = detectWordFamily(input);
    assert.equal(r?.isFamilyMember, true);
    assert.equal(r?.reason, 'plural-noun');
    assert.equal(r?.headword, singular);
    assert.deepEqual(r?.forms, [singular, input]);
  }
});

test('does NOT fire on regular base forms (avoid prompting on every entry)', () => {
  // Singular nouns / regular-verb bases read as noise — no family prompt.
  for (const input of ['cat', 'shoe', 'walk', 'play', 'the', 'beautiful', 'happy']) {
    const r = detectWordFamily(input);
    assert.equal(r?.isFamilyMember, false, `${input} should not trigger a family`);
  }
});

test('"goes" is treated as a verb (not a plural noun) — POS priority', () => {
  const r = detectWordFamily('goes');
  assert.equal(r?.reason, 'irregular-verb');
  assert.equal(r?.headword, 'go');
});

test('multi-word / empty / whitespace inputs return null', () => {
  assert.equal(detectWordFamily(''), null);
  assert.equal(detectWordFamily('   '), null);
  assert.equal(detectWordFamily('take off'), null);
  assert.equal(detectWordFamily('take  off'), null);
});
