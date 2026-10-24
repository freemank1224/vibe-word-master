import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMonsterSurfService, estimateMonsterSurfReward, MonsterSurfServiceError,
  type MonsterSurfRpcTransport,
} from '../../services/monsterSurfService.ts';

const runId = '633c9b6f-82d6-435f-b521-f23242567c87';
const wordId = '73ef0252-a721-4fb8-834c-6097e84d3549';
const activeRun = {
  id: runId, status: 'active', started_at: '2026-10-24T12:00:00Z', settled_at: null,
  words: [{ word_id: wordId, answer: 'ocean', meaning_zh: '海洋', meaning_en: 'A vast body of water.', audio_url: null }],
  entry_fee: 1, crystals: 0, correct_count: 0, reward_coins: 0, net_coins: -1,
};
const settledRun = {
  ...activeRun, status: 'settled', settled_at: '2026-10-24T12:02:00Z',
  crystals: 430, correct_count: 1, reward_coins: 1, net_coins: 0,
};
const transport = (data: unknown): MonsterSurfRpcTransport => ({ rpc: async () => ({ data, error: null }) });

test('Sea Crystal exchange remains bounded by correct words, including large pickup totals', () => {
  assert.equal(estimateMonsterSurfReward(1, 430), 1);
  assert.equal(estimateMonsterSurfReward(20, 430), 20);
  assert.equal(estimateMonsterSurfReward(20, 89), 8);
  assert.equal(estimateMonsterSurfReward(0, 1000), 0);
  assert.equal(estimateMonsterSurfReward(-1, 100), 0);
  assert.equal(estimateMonsterSurfReward(5, Infinity), 0);
});

test('account recovery returns original paid deck and authoritative balance', async () => {
  const service = createMonsterSurfService(transport({ balance: 27, active_run: activeRun }));
  const result = await service.getMonsterSurfAccount();
  assert.equal(result.balance, 27);
  assert.equal(result.activeRun?.entryFee, 1);
  assert.equal(result.activeRun?.words[0].wordId, wordId);
  assert.equal(result.activeRun?.words[0].meaningZh, '海洋');
  assert.equal(result.activeRun?.netCoins, -1);
  assert.equal(result.activeRun?.mode, null);
});

test('start sends fixed run identity and ordered word ids, never a debit amount', async () => {
  const calls: unknown[] = [];
  const service = createMonsterSurfService({ rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { run: activeRun, balance: 27, charged: false, recovered: true }, error: null };
  } });
  const result = await service.startMonsterSurfRun(runId, [wordId]);
  assert.deepEqual(calls, [{ name: 'start_monster_surf_run_v2', args: { p_run_id: runId, p_word_ids: [wordId], p_mode: { kind: 'fixed', wordCount: 20 } } }]);
  assert.equal(result.charged, false);
  assert.equal(result.recovered, true);
});

test('Endless preserves the full paid deck and settlement beyond100 correct words', async () => {
  const words = Array.from({ length: 1200 }, (_, index) => ({ ...activeRun.words[0], word_id: `word-${index}`, answer: `answer-${index}` }));
  const run = { ...settledRun, words, mode: { kind: 'endless' }, crystals: 12000, correct_count: 1200, reward_coins: 1200, net_coins: 1199 };
  const service = createMonsterSurfService(transport({ run, balance: 1500, already_settled: false }));
  const result = await service.settleMonsterSurfRun(runId, 12000, []);
  assert.equal(result.run.words.length, 1200);
  assert.deepEqual(result.run.mode, { kind: 'endless' });
  assert.equal(result.run.netCoins, 1199);
});

test('starting Endless sends its persisted mode and every ordered word id', async () => {
  const calls: unknown[] = [];
  const mode = { kind: 'endless' } as const;
  const words = Array.from({ length: 150 }, (_, index) => ({ ...activeRun.words[0], word_id: `word-${index}` }));
  const service = createMonsterSurfService({ rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { run: { ...activeRun, mode, words }, balance: 26, charged: true, recovered: false }, error: null };
  } });
  const ids = words.map(word => word.word_id);
  const result = await service.startMonsterSurfRun(runId, ids, mode);
  assert.deepEqual(calls, [{ name: 'start_monster_surf_run_v2', args: { p_run_id: runId, p_word_ids: ids, p_mode: mode } }]);
  assert.equal(result.run.words.length, 150);
  assert.deepEqual(result.run.mode, mode);
});

test('fixed modes allow a small library but reject malformed modes and oversized returned decks', async () => {
  const service = createMonsterSurfService(transport({ balance: 27, active_run: { ...activeRun, mode: { kind: 'fixed', wordCount: 10 } } }));
  assert.equal((await service.getMonsterSurfAccount()).activeRun?.words.length, 1);
  for (const mode of [{ kind: 'fixed', wordCount: 9 }, { kind: 'fixed', wordCount: 51 }, { kind: 'fixed', wordCount: 20.5 }, { kind: 'other' }]) {
    const bad = createMonsterSurfService(transport({ balance: 27, active_run: { ...activeRun, mode } }));
    await assert.rejects(bad.getMonsterSurfAccount(), error => error instanceof MonsterSurfServiceError && error.code === 'unexpected_response');
  }
  const oversized = createMonsterSurfService(transport({ balance: 27, active_run: {
    ...activeRun, mode: { kind: 'fixed', wordCount: 10 }, words: Array.from({ length: 11 }, () => activeRun.words[0]),
  } }));
  await assert.rejects(oversized.getMonsterSurfAccount(), error => error instanceof MonsterSurfServiceError && error.code === 'unexpected_response');
});

test('settlement submits the ordered answers and crystal count instead of an arbitrary reward', async () => {
  const calls: unknown[] = [];
  const service = createMonsterSurfService({ rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { run: settledRun, balance: 28, already_settled: true }, error: null };
  } });
  const result = await service.settleMonsterSurfRun(runId, 430, [
    { wordId, answer: 'oceen' }, { wordId, answer: 'ocean' },
  ]);
  assert.deepEqual(calls, [{ name: 'settle_monster_surf_run_v1', args: {
    p_run_id: runId, p_crystals: 430, p_attempts: [
      { word_id: wordId, answer: 'oceen' }, { word_id: wordId, answer: 'ocean' },
    ],
  } }]);
  assert.equal(result.alreadySettled, true);
  assert.equal(result.run.rewardCoins, 1);
  assert.equal(result.balance, 28);
});

test('insufficient balance and authentication errors cannot become a free run', async () => {
  for (const code of ['insufficient_balance', 'not_authenticated', 'invalid_words']) {
    const service = createMonsterSurfService(transport({ error: code }));
    await assert.rejects(service.startMonsterSurfRun(runId, [wordId]), error =>
      error instanceof MonsterSurfServiceError && error.code === code);
  }
});

test('missing migration and network failure remain distinguishable and retryable', async () => {
  const missing = createMonsterSurfService({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Unknown RPC' } }) });
  await assert.rejects(missing.getMonsterSurfAccount(), error => error instanceof MonsterSurfServiceError && error.code === 'backend_unavailable');
  const network = createMonsterSurfService({ rpc: async () => { throw new Error('connection lost'); } });
  await assert.rejects(network.settleMonsterSurfRun(runId, 430, []), error => error instanceof MonsterSurfServiceError && error.code === 'network_error');
});

test('inconsistent settlement is rejected instead of claiming coins were credited', async () => {
  for (const run of [
    { ...settledRun, reward_coins: 430, net_coins: 429 },
    { ...settledRun, net_coins: 1 },
    { ...settledRun, crystals: 0 },
    { ...settledRun, id: 'another-run' },
    activeRun,
  ]) {
    const service = createMonsterSurfService(transport({ run, balance: 28, already_settled: false }));
    await assert.rejects(service.settleMonsterSurfRun(runId, 430, [{ wordId, answer: 'ocean' }]), error =>
      error instanceof MonsterSurfServiceError && error.code === 'unexpected_response');
  }
});
