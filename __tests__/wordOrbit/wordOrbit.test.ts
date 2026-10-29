import test from 'node:test';
import assert from 'node:assert/strict';
import type { WordEntry } from '../../types.ts';
import {
  advanceWordOrbit, createWordOrbitState, hintWordOrbit, orbitWordBudget, selectWordOrbitQuestions,
  skipWordOrbit, submitWordOrbit, summarizeWordOrbit, toWordOrbitQuestion, wordOrbitReviewQuestions,
  wordOrbitClue, formatOrbitMessage,
} from '../../services/wordOrbit.ts';
import type { OrbitMessage, WordOrbitQuestion, WordOrbitState } from '../../services/wordOrbit.ts';

const questions: WordOrbitQuestion[] = [
  { wordId: 'sun', answer: 'sun', clue: '太阳' },
  { wordId: 'open', answer: 'open', clue: '打开' },
  { wordId: 'bridge', answer: 'bridge', clue: '桥' },
];
const playing = (): WordOrbitState => ({ ...createWordOrbitState(questions, 'round-id', 1000), phase: 'playing' });
const word = (id: string, text: string, definition_cn: string | null): WordEntry => ({
  id, text, definition_cn, timestamp: 1000, sessionId: 'session', correct: false, tested: false,
  error_count: 0, best_time_ms: null, last_tested: null, phonetic: null, audio_url: null, definition_en: null,
});

test('real words use checked short sentences only for the matching sense', () => {
  assert.equal(toWordOrbitQuestion(word('sun', ' Sun ', '太阳'))?.before, 'The ');
  assert.equal(toWordOrbitQuestion(word('open', 'open', '开着的'))?.before, undefined);
  assert.equal(toWordOrbitQuestion(word('o', 'orbit', '轨道'))?.clue, '轨道');
  assert.equal(toWordOrbitQuestion(word('x', 'x', '未知数')), null);
  assert.equal(toWordOrbitQuestion(word('bad', 'hello world', '你好')), null);
  assert.equal(toWordOrbitQuestion(word('empty', 'hello', null)), null);
  assert.equal(toWordOrbitQuestion(word('leak', 'open', 'open 意为打开')), null);
  assert.equal(toWordOrbitQuestion({ ...word('d', 'sun', '太阳'), deleted: true }), null);
});

test('selection lets adaptive priority rank duplicate words before keeping one copy', async () => {
  const words = [word('s', 'sun', '太阳'), word('s2', 'SUN', '太阳'), word('o', 'open', '打开'), word('bad', 'bad', null)];
  const sessions = [{ id: 'session', timestamp: 0, wordCount: 4, targetCount: 4 }];
  const selected = await selectWordOrbitQuestions(words, sessions, (all, pool, count, history) => {
    assert.equal(all, words); assert.equal(history, sessions);
    assert.deepEqual(pool.map(item => item.id), ['s', 's2', 'o']); assert.equal(count, 3);
    return pool.slice().reverse();
  });
  assert.deepEqual(selected.map(item => item.wordId), ['o', 's2']);
});

test('word budgets respect spelling length and cap at 15 seconds', () => {
  assert.equal(orbitWordBudget('sun'), 10_100);
  assert.equal(orbitWordBudget('open'), 10_800);
  assert.equal(orbitWordBudget('extraordinary'), 15_000);
});

test('correct answers immediately advance while emitting all three obstacle actions', () => {
  let state = playing();
  const actions: string[] = [];
  for (const question of questions) {
    const next = submitWordOrbit({ ...state, input: ` ${question.answer.toUpperCase()} ` }, 1_000);
    actions.push(next.effects[0].action); state = next.state;
  }
  assert.deepEqual(actions, ['jump', 'slide', 'jet']);
  assert.equal(state.phase, 'finished'); assert.equal(state.bestCombo, 3); assert.equal(state.score, 360);
  assert.equal(state.results.length, 3); assert.equal(state.results[0].responseTimeMs, 1000);
});

test('a first wrong submit keeps input, falls once and guarantees a three-second correction window', () => {
  const state = { ...playing(), questionRemainingMs: 900, input: 'san', combo: 3 };
  const first = submitWordOrbit(state);
  assert.equal(first.state.input, 'san'); assert.equal(first.state.combo, 0);
  assert.equal(first.state.questionRemainingMs, 3000); assert.equal(first.state.remainingMs, 90000);
  assert.equal(first.effects[0].action, 'fall'); assert.equal(first.state.index, 0);
  const again = submitWordOrbit(first.state, 2500);
  assert.equal(again.effects.length, 0); assert.equal(again.state.questionRemainingMs, 500);
  const corrected = submitWordOrbit({ ...again.state, input: 'sun' });
  assert.equal(corrected.effects[0].action, 'jump'); assert.equal(corrected.state.results[0].hadMistake, true);
  assert.equal(corrected.state.results[0].status, 'correct'); assert.equal(corrected.state.combo, 0);
  assert.equal(corrected.state.score, 50);
});

test('empty submits neither fall nor reset the clock', () => {
  const next = submitWordOrbit({ ...playing(), input: '  ' }, 500);
  assert.equal(next.effects.length, 0); assert.equal(next.state.hadMistake, false);
  assert.equal(next.state.questionRemainingMs, orbitWordBudget('sun') - 500);
});

test('word timeout prevents a late submit from answering the next word', () => {
  const next = submitWordOrbit({ ...playing(), input: 'open', questionRemainingMs: 10 }, 10);
  assert.equal(next.state.index, 1); assert.equal(next.state.correctCount, 0);
  assert.equal(next.state.input, ''); assert.equal(next.state.results[0].status, 'incorrect');
  assert.equal(next.state.questionRemainingMs, orbitWordBudget('open'));
});

test('total deadline wins over simultaneous word timeout and cannot add a late correct answer', () => {
  const next = submitWordOrbit({ ...playing(), remainingMs: 5, questionRemainingMs: 5, input: 'sun' }, 5);
  assert.equal(next.state.phase, 'finished'); assert.equal(next.state.correctCount, 0);
  assert.equal(next.state.results.length, 1); assert.equal(next.state.results[0].status, 'incorrect');
  assert.equal(next.effects.length, 0);
  assert.equal(submitWordOrbit(next.state).state.results.length, 1);
});

test('an untouched word at the total deadline is unattempted and excluded from review', () => {
  const next = advanceWordOrbit({ ...playing(), remainingMs: 2 }, 1000).state;
  assert.equal(next.results[0].status, 'unattempted'); assert.equal(next.questionElapsedMs, 2);
  assert.equal(wordOrbitReviewQuestions(next).length, 0);
});

test('paused clock cannot expire words or accept answers', () => {
  const state = { ...playing(), phase: 'paused' as const, input: 'sun' };
  assert.equal(advanceWordOrbit(state, 500000).state, state);
  assert.equal(submitWordOrbit(state, 500000).state, state);
});

test('hints break combo, remain in result, and corrected or skipped words enter review', () => {
  let state = hintWordOrbit({ ...playing(), combo: 4 });
  assert.equal(state.combo, 0); assert.equal(state.hintUsed, true);
  state = submitWordOrbit({ ...state, input: 'sun' }, 3000).state;
  state = skipWordOrbit(state);
  state = submitWordOrbit({ ...state, input: 'bridge' }, 2000).state;
  assert.deepEqual(wordOrbitReviewQuestions(state).map(item => item.wordId), ['sun', 'open']);
  const summary = summarizeWordOrbit(state, 60_000);
  assert.equal(summary.roundId, 'round-id'); assert.equal(summary.occurredAt, 60_000);
  assert.equal(summary.rulesVersion, 'orbit-practice-v1'); assert.equal(summary.durationSeconds, 5);
  assert.equal(summary.correctCount, 2); assert.equal(summary.results[0].hintUsed, true);
  summary.results[0].status = 'incorrect';
  assert.equal(state.results[0].status, 'correct', 'summary must not mutate in-memory results');
});

test('early completion keeps only completed answers and timestamps the actual completion', () => {
  const answered = submitWordOrbit({ ...playing(), input: 'sun' }, 1000).state;
  const partial = { ...answered, phase: 'finished' as const, input: 'op' };
  const summary = summarizeWordOrbit(partial, 3_601_000);
  assert.equal(summary.occurredAt, 3_601_000, 'a long pause must not backdate the review');
  assert.equal(summary.durationSeconds, 1);
  assert.deepEqual(summary.results.map(result => result.wordId), ['sun']);
  assert.equal(summary.results[0].status, 'correct');
});

test('repeated errors and then timeout do not trigger a second fall', () => {
  const wrong = submitWordOrbit({ ...playing(), input: 'san' }).state;
  const expired = advanceWordOrbit(wrong, wrong.questionRemainingMs);
  assert.equal(expired.effects.length, 0); assert.equal(expired.state.index, 1);
  assert.equal(expired.state.results[0].hadMistake, true);
});

test('long delayed frames cannot manufacture failures for unseen future questions', () => {
  const delayed = advanceWordOrbit(playing(), 40_000).state;
  assert.equal(delayed.results.length, 1); assert.equal(delayed.index, 1);
  assert.equal(delayed.questionElapsedMs, 0); assert.equal(delayed.remainingMs, 50_000);
});

test('the selected Chinese meaning stays visible in both interface languages', () => {
  const entry = {
    ...word('open', 'open', '打开'), definition_en: 'Not closed; allowing passage.', selected_meaning_key: 'verb',
    meaning_options: [{ key: 'verb', meaningZh: '打开', definitionEn: 'To open something that was closed.' }],
  };
  const question = toWordOrbitQuestion(entry)!;
  assert.equal(wordOrbitClue(question, 'zh'), '打开');
  assert.equal(wordOrbitClue(question, 'en'), '打开');
  const noSelectedEnglish = toWordOrbitQuestion({ ...entry, meaning_options: [{ key: 'verb', meaningZh: '打开' }] })!;
  assert.equal(wordOrbitClue(noSelectedEnglish, 'en'), '打开');
  const englishOnly = toWordOrbitQuestion({ ...word('orbit', 'orbit', null), definition_en: 'A curved path around a planet.' })!;
  assert.equal(wordOrbitClue(englishOnly, 'en'), 'A curved path around a planet.');
});

test('Chinese-only saved words keep their meanings in English mode', () => {
  for (const [answer, meaning] of [['at', '在'], ['sun', '太阳'], ['orbit', '轨道'], ['sky', '天空']]) {
    const question = toWordOrbitQuestion(word(answer, answer, meaning))!;
    const clue = wordOrbitClue(question, 'en');
    assert.equal(clue, meaning);
    assert.equal(wordOrbitClue(question, 'zh'), meaning);
  }
  const mixed = toWordOrbitQuestion({ ...word('orbit', 'orbit', '轨道'), definition_en: 'path 轨道' })!;
  assert.equal(wordOrbitClue(mixed, 'en'), '轨道');
});

test('feedback and animation messages can change language without changing game state', () => {
  const state = submitWordOrbit({ ...playing(), input: 'san' }, 500).state;
  const snapshot = structuredClone(state);
  assert.match(formatOrbitMessage(state.feedback, 'en'), /stumbled/);
  assert.match(formatOrbitMessage(state.feedback, 'zh'), /摔/);
  assert.deepEqual(state, snapshot, 'changing the displayed language must preserve the clock and typed answer');
  const messages: OrbitMessage[] = [
    ...(['intro', 'timeUp', 'empty', 'wrong', 'leave', 'autoPause', 'pause', 'resume', 'missedBurst', 'recover', 'fall'] as const).map(key => ({ key })),
    ...(['missed', 'skip', 'correct', 'corrected'] as const).map(key => ({ key, question: questions[0] })),
    { key: 'hint', letter: 'S' }, { key: 'combo', combo: 3 },
    ...(['jump', 'slide', 'jet'] as const).map(action => ({ key: 'action' as const, action })),
  ];
  for (const message of messages) {
    const englishMessage = formatOrbitMessage(message, 'en');
    if (message.key === 'missed' || message.key === 'skip') {
      assert.ok(englishMessage.includes(message.question.clue), 'feedback keeps the saved Chinese meaning');
      assert.equal(/\p{Script=Han}/u.test(englishMessage.replace(message.question.clue, '')), false, message.key);
    } else {
      assert.equal(/\p{Script=Han}/u.test(englishMessage), false, message.key);
    }
    assert.ok(formatOrbitMessage(message, 'zh').length > 0);
  }
});
