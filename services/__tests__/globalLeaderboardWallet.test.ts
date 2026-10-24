import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { supabase } from '../../lib/supabaseClient.ts';
import { clearGlobalChampionsCache, fetchGlobalChampions, fetchGlobalLeaderboard, withCoinChampion, type ChampionInfo, type LeaderboardRow } from '../globalLeaderboard.ts';
import { notifyWalletChanged, subscribeToWalletChanges } from '../walletUpdates.ts';

const champion = (category: ChampionInfo['category'], scoreValue: number): ChampionInfo => ({
  category, categoryLabel: category, categoryIcon: 'star', championUserId: 'leader', championName: 'Leader', championAvatar: null, scoreValue, scoreLabel: 'points',
});
const row = (scoreValue: number): LeaderboardRow => ({ rankPosition: 1, userId: 'new-leader', displayName: 'New leader', emailMasked: '', avatarUrl: null, scoreValue, scoreLabel: 'coins', isCurrentUser: false });
const rawRow = (score: number) => ({ rank_position: 1, user_id: 'new-leader', display_name: 'New leader', score_value: score, score_label: 'coins', is_current_user: false });

test('wallet changes replace only the wealth champion and preserve all unrelated slides', () => {
  const daily = champion('daily_total', 900);
  const game = champion('game_total', 800);
  const before = [daily, champion('coins', 20), game];
  const after = withCoinChampion(before, [row(35)]);
  assert.equal(after[0], daily);
  assert.equal(after[2], game);
  assert.equal(after[1].scoreValue, 35);
  assert.equal(after[1].championUserId, 'new-leader');
  assert.equal(before[1].scoreValue, 20, 'existing rows are not mutated');
  assert.deepEqual(withCoinChampion(before, []), [daily, game]);
});

test('wealth views share one request, but a later payment cannot reuse or cache an older balance', async t => {
  clearGlobalChampionsCache();
  let userId = 'account-a';
  t.mock.method(supabase.auth, 'getSession', async () => ({ data: { session: { user: { id: userId } } }, error: null }));
  const pending: Array<(value: unknown) => void> = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(supabase, 'rpc', async (name: string, args: unknown) => {
    calls.push({ name, args });
    if (name === 'get_global_champions') return { data: [
      { category: 'daily_total', champion_user_id: 'leader', champion_name: 'Leader', score_value: 900 },
      { category: 'coins', champion_user_id: 'leader', champion_name: 'Leader', score_value: 20 },
    ], error: null };
    return await new Promise(resolve => { pending.push(resolve); });
  });
  await fetchGlobalChampions();
  const old = fetchGlobalLeaderboard('coins', 10);
  const duplicate = fetchGlobalLeaderboard('coins', 10);
  await setImmediate();
  assert.equal(pending.length, 1);

  const target = Object.assign(new EventTarget(), {
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    localStorage: { setItem: () => {} },
  }) as unknown as Window;
  const stop = subscribeToWalletChanges(() => {}, target);
  notifyWalletChanged(target);
  const fresh = fetchGlobalLeaderboard('coins', 10);
  await setImmediate();
  assert.equal(pending.length, 2, 'a committed payment gets a new read even while an older read is pending');
  pending[1]({ data: [rawRow(35)], error: null });
  assert.equal((await fresh)[0].scoreValue, 35);
  pending[0]({ data: [rawRow(20)], error: null });
  assert.equal((await old)[0].scoreValue, 20);
  assert.equal((await duplicate)[0].scoreValue, 20);
  const cached = await fetchGlobalChampions();
  assert.equal(cached.find(item => item.category === 'coins')?.scoreValue, 35);
  assert.equal(cached.find(item => item.category === 'daily_total')?.scoreValue, 900);
  assert.equal(calls.filter(call => call.name === 'get_global_champions').length, 1, 'a payment does not reload other categories');

  const accountA = fetchGlobalLeaderboard('coins', 10);
  await setImmediate();
  userId = 'account-b';
  const accountB = fetchGlobalLeaderboard('coins', 10);
  await setImmediate();
  assert.equal(pending.length, 4, 'is_current_user rows cannot leak across accounts');
  pending[2]({ data: [], error: null }); pending[3]({ data: [], error: null });
  await Promise.all([accountA, accountB]);
  stop(); clearGlobalChampionsCache();
});

test('a failed wealth request releases its deduplication entry so retry can read the credited amount', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(supabase.auth, 'getSession', async () => ({ data: { session: null }, error: null }));
  let failed = true;
  t.mock.method(supabase, 'rpc', async () => failed
    ? { data: null, error: new Error('offline') }
    : { data: [rawRow(35)], error: null });
  await assert.rejects(fetchGlobalLeaderboard('coins'), /offline/);
  failed = false;
  assert.equal((await fetchGlobalLeaderboard('coins'))[0].scoreValue, 35);
});
