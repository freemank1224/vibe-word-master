import type { InputSession, WordEntry } from '../types.ts';

export const WORD_ORBIT_RULES_VERSION = 'orbit-practice-v1';
export const WORD_ORBIT_DURATION_MS = 90_000;
export const WORD_ORBIT_BATCH_SIZE = 24;
export type OrbitObstacle = 'rock' | 'arch' | 'gap';
export type OrbitAction = 'jump' | 'slide' | 'jet' | 'fall';
export type OrbitPhase = 'ready' | 'playing' | 'paused' | 'finished';

export interface WordOrbitQuestion {
  wordId: string;
  answer: string;
  clue: string;
  before?: string;
  after?: string;
}
export interface WordOrbitResult {
  wordId: string;
  status: 'correct' | 'incorrect' | 'skipped' | 'unattempted';
  hadMistake: boolean;
  hintUsed: boolean;
  responseTimeMs: number;
}
export interface WordOrbitSummary {
  roundId: string;
  occurredAt: number;
  durationSeconds: number;
  correctCount: number;
  results: WordOrbitResult[];
  score: number;
  bestCombo: number;
  distance: number;
  rulesVersion: typeof WORD_ORBIT_RULES_VERSION;
}
export interface WordOrbitState {
  roundId: string;
  occurredAt: number;
  questions: WordOrbitQuestion[];
  phase: OrbitPhase;
  index: number;
  input: string;
  remainingMs: number;
  questionRemainingMs: number;
  questionElapsedMs: number;
  hadMistake: boolean;
  hintUsed: boolean;
  combo: number;
  bestCombo: number;
  correctCount: number;
  score: number;
  distance: number;
  results: WordOrbitResult[];
  feedback: string;
  invalid: boolean;
}
export interface OrbitEffect { action: OrbitAction; obstacle: OrbitObstacle; text: string }
export interface OrbitTransition { state: WordOrbitState; effects: OrbitEffect[] }
export const ORBIT_TERRAINS = [
  { obstacle: 'rock', action: 'jump', name: '岩台', verb: '翻越' },
  { obstacle: 'arch', action: 'slide', name: '低拱门', verb: '滑铲' },
  { obstacle: 'gap', action: 'jet', name: '裂隙', verb: '飞跃' },
] as const;
export const ORBIT_ACTION_SECONDS: Record<OrbitAction, number> = { jump: .86, slide: .85, jet: 1, fall: .75 };
export const orbitWordBudget = (answer: string) => Math.min(15_000, 8_000 + answer.length * 700);
export const normalizeOrbitAnswer = (value: string) => value.trim().toLocaleLowerCase('en').replace(/[’‘]/g, "'");

// Short, manually checked sentences are used only for matching Chinese senses.
// Other words use their saved meaning, so a round never waits for generated content.
const SENTENCES: Record<string, { before: string; after: string; meaning: RegExp }> = {
  sun: { before: 'The ', after: ' rises in the east.', meaning: /太阳/ },
  open: { before: 'Please ', after: ' the door.', meaning: /打开|开启/ },
  bridge: { before: 'We crossed the ', after: ' to reach the island.', meaning: /桥/ },
  river: { before: 'A small ', after: ' flows through the village.', meaning: /河/ },
  careful: { before: 'Be ', after: ' when you cross the road.', meaning: /小心|仔细/ },
  courage: { before: 'Her smile gave me ', after: '.', meaning: /勇气/ },
  quiet: { before: 'The room became ', after: ' after midnight.', meaning: /安静/ },
  journey: { before: 'Every great ', after: ' starts with one step.', meaning: /旅程|旅行/ },
  notice: { before: 'Can you ', after: ' the difference?', meaning: /注意|察觉/ },
  future: { before: 'We can build a better ', after: '.', meaning: /未来|将来/ },
  progress: { before: 'Small steps lead to ', after: '.', meaning: /进步|进展/ },
  enjoy: { before: 'Try to ', after: ' every little moment.', meaning: /享受|喜爱|喜欢/ },
};

export function toWordOrbitQuestion(word: WordEntry): WordOrbitQuestion | null {
  const answer = normalizeOrbitAnswer(word.text || '');
  const selectedMeaning = word.meaning_options?.find(option => option.key === word.selected_meaning_key)?.meaningZh;
  const clue = (selectedMeaning || word.definition_cn || '').trim();
  if (word.deleted || !/^[a-z]+(?:[-'][a-z]+)*$/.test(answer) || answer.length < 2 || answer.length > 18 || !clue || clue.length > 240) return null;
  // A clue containing the answer would make the recall task meaningless.
  if (new RegExp(`\\b${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clue)) return null;
  const sentence = SENTENCES[answer];
  return { wordId: word.id, answer, clue, ...(sentence?.meaning.test(clue) ? { before: sentence.before, after: sentence.after } : {}) };
}

type OrbitSelectQueue = (all: WordEntry[], pool: WordEntry[], count: number, sessions?: InputSession[]) => WordEntry[];
export async function selectWordOrbitQuestions(allWords: WordEntry[], sessions: InputSession[], select?: OrbitSelectQueue): Promise<WordOrbitQuestion[]> {
  // Let the scheduler rank before deduplication, preserving the most urgent copy.
  const pool = allWords.filter(word => toWordOrbitQuestion(word) !== null);
  if (!pool.length) return [];
  let selector = select;
  if (!selector) {
    const { adaptiveWordSelector } = await import('./adaptiveWordSelector.ts');
    selector = adaptiveWordSelector.calculateQueue.bind(adaptiveWordSelector);
  }
  const seen = new Set<string>();
  return selector(allWords, pool, Math.min(WORD_ORBIT_BATCH_SIZE, pool.length), sessions)
    .map(toWordOrbitQuestion).filter((question): question is WordOrbitQuestion => {
      if (!question || seen.has(question.answer)) return false;
      seen.add(question.answer);
      return true;
    });
}

export function createWordOrbitState(questions: WordOrbitQuestion[], roundId: string, occurredAt = Date.now()): WordOrbitState {
  return {
    roundId, occurredAt, questions, phase: 'ready', index: 0, input: '',
    remainingMs: WORD_ORBIT_DURATION_MS, questionRemainingMs: orbitWordBudget(questions[0]?.answer || ''), questionElapsedMs: 0,
    hadMistake: false, hintUsed: false, combo: 0, bestCombo: 0, correctCount: 0, score: 0, distance: 0, results: [],
    feedback: '答对翻越，答错保留输入，改对继续。', invalid: false,
  };
}

function record(state: WordOrbitState, status: WordOrbitResult['status']): WordOrbitResult {
  return { wordId: state.questions[state.index].wordId, status, hadMistake: state.hadMistake, hintUsed: state.hintUsed, responseTimeMs: Math.round(state.questionElapsedMs) };
}
function nextQuestion(state: WordOrbitState): WordOrbitState {
  const index = state.index + 1;
  return {
    ...state, index, input: '', invalid: false, hadMistake: false, hintUsed: false, questionElapsedMs: 0,
    questionRemainingMs: orbitWordBudget(state.questions[index]?.answer || ''),
    phase: index >= state.questions.length ? 'finished' : 'playing',
  };
}

/** Clock advancement is pure. The caller passes active time only; paused time is never charged. */
export function advanceWordOrbit(state: WordOrbitState, deltaMs: number): OrbitTransition {
  if (state.phase !== 'playing' || !Number.isFinite(deltaMs) || deltaMs <= 0) return { state, effects: [] };
  const elapsed = Math.min(deltaMs, state.remainingMs);
  let next = { ...state, remainingMs: Math.max(0, state.remainingMs - elapsed), questionRemainingMs: Math.max(0, state.questionRemainingMs - elapsed), questionElapsedMs: state.questionElapsedMs + elapsed, distance: state.distance + elapsed * .005 };
  if (next.remainingMs <= 0) {
    const attempted = Boolean(next.input.trim()) || next.hadMistake || next.hintUsed;
    return { state: { ...next, phase: 'finished', results: [...next.results, record(next, attempted ? 'incorrect' : 'unattempted')], feedback: '时间到，收好这一程。' }, effects: [] };
  }
  if (next.questionRemainingMs <= 0) {
    const terrain = ORBIT_TERRAINS[next.index % 3];
    const question = next.questions[next.index];
    const effects: OrbitEffect[] = next.hadMistake ? [] : [{ action: 'fall', obstacle: terrain.obstacle, text: '没赶上，下一步继续' }];
    next = { ...next, combo: 0, results: [...next.results, record(next, 'incorrect')], feedback: `没赶上：${question.answer} · ${question.clue}` };
    return { state: nextQuestion(next), effects };
  }
  return { state: next, effects: [] };
}

/** Advance the clock before submitting. A submit cannot be applied to a word that just expired. */
export function submitWordOrbit(state: WordOrbitState, deltaMs = 0): OrbitTransition {
  const advanced = advanceWordOrbit(state, deltaMs);
  if (advanced.state.phase !== 'playing' || advanced.state.index !== state.index) return advanced;
  const current = advanced.state;
  const question = current.questions[current.index];
  const terrain = ORBIT_TERRAINS[current.index % 3];
  if (!current.input.trim()) return { state: { ...current, feedback: '先填入一个单词。' }, effects: [] };
  if (normalizeOrbitAnswer(current.input) === question.answer) {
    const clean = !current.hadMistake && !current.hintUsed;
    const combo = clean ? current.combo + 1 : 0;
    const points = clean ? 100 + Math.min(combo, 10) * 10 : 50;
    const next = { ...current, combo, bestCombo: Math.max(current.bestCombo, combo), correctCount: current.correctCount + 1, score: current.score + points, distance: current.distance + 12, results: [...current.results, record(current, 'correct')], feedback: `${question.answer} · ${clean ? '漂亮！' : '修正成功，继续。'}` };
    return { state: nextQuestion(next), effects: [{ action: terrain.action, obstacle: terrain.obstacle, text: combo && combo % 3 === 0 ? `连越 ${combo}！` : current.hadMistake ? '稳住，补跳！' : `${terrain.verb}成功` }] };
  }
  return {
    state: { ...current, combo: 0, hadMistake: true, invalid: true, questionRemainingMs: current.hadMistake ? current.questionRemainingMs : Math.max(3_000, current.questionRemainingMs), feedback: '摔了一跤。输入保留，改对就能补跳。' },
    effects: current.hadMistake ? [] : [{ action: 'fall', obstacle: terrain.obstacle, text: '哎哟！还能救' }],
  };
}

export function hintWordOrbit(state: WordOrbitState): WordOrbitState {
  if (state.phase !== 'playing' || state.hintUsed) return state;
  return { ...state, hintUsed: true, combo: 0, feedback: `首字母 ${state.questions[state.index].answer[0].toUpperCase()} · 本题不累计连击。` };
}
export function skipWordOrbit(state: WordOrbitState): WordOrbitState {
  if (state.phase !== 'playing') return state;
  const question = state.questions[state.index];
  return nextQuestion({ ...state, combo: 0, results: [...state.results, record(state, 'skipped')], feedback: `绕行：${question.answer} · ${question.clue}` });
}
export function summarizeWordOrbit(state: WordOrbitState, completedAt = Date.now()): WordOrbitSummary {
  // Review intervals start at the actual completion, including after a long pause.
  // The component caches this summary so retries preserve the same timestamp.
  return { roundId: state.roundId, occurredAt: completedAt, durationSeconds: (WORD_ORBIT_DURATION_MS - state.remainingMs) / 1_000, correctCount: state.correctCount, results: state.results.map(result => ({ ...result })), score: state.score, bestCombo: state.bestCombo, distance: Math.floor(state.distance), rulesVersion: WORD_ORBIT_RULES_VERSION };
}
export function wordOrbitReviewQuestions(state: WordOrbitState): WordOrbitQuestion[] {
  const ids = new Set(state.results.filter(result => result.status !== 'unattempted' && (result.status !== 'correct' || result.hadMistake || result.hintUsed)).map(result => result.wordId));
  return state.questions.filter(question => ids.has(question.wordId));
}
