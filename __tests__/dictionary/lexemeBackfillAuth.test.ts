import assert from 'node:assert/strict';
import test from 'node:test';
import { isLexemeBackfillAuthorized } from '../../supabase/functions/_shared/lexemeBackfillAuth.ts';

test('the privileged worker fails closed on missing, weak or incorrect credentials', () => {
  const secret = 'a'.repeat(64);
  assert.equal(isLexemeBackfillAuthorized('', ''), false);
  assert.equal(isLexemeBackfillAuthorized('short', 'short'), false);
  assert.equal(isLexemeBackfillAuthorized(secret, ''), false);
  assert.equal(isLexemeBackfillAuthorized(secret, 'b'.repeat(64)), false);
  assert.equal(isLexemeBackfillAuthorized(secret, 'a'.repeat(63)), false);
  assert.equal(isLexemeBackfillAuthorized(secret, secret), true);
});
