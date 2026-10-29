import assert from 'node:assert/strict';
import test from 'node:test';
import { firstChineseMeaning, normalizeChineseMeaning, splitChineseMeanings } from '../../supabase/functions/_shared/chineseMeaning.ts';

test('only actual Chinese meanings are admitted from providers and the shared cache', () => {
  for (const invalid of [null, undefined, '', 'sabertooth', ' A type of large constricting snake ', '暂无中文释义', 'n/a']) {
    assert.equal(normalizeChineseMeaning(invalid), undefined);
  }
  assert.equal(normalizeChineseMeaning('  剑齿虎\n（动物） '), '剑齿虎 （动物）');
  assert.equal(normalizeChineseMeaning('U型'), 'U型');
  assert.equal(firstChineseMeaning(['sabertooth', '暂无中文释义', '剑齿虎']), '剑齿虎');
  assert.equal(firstChineseMeaning(['sabertooth']), undefined);
});

test('translation fallback rejects echoed words and retains valid Chinese candidates', () => {
  assert.deepEqual(splitChineseMeanings('sabertooth'), []);
  assert.deepEqual(splitChineseMeanings('sabertooth; 剑齿虎；剑齿虎，剑齿'), ['剑齿虎', '剑齿']);
  assert.deepEqual(splitChineseMeanings('暂无释义; -; 剑齿虎'), ['剑齿虎']);
});
