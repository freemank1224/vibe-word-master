/**
 * TDD tests for the pure scene-design module.
 *
 * Covers the refreshed image pipeline (docs/scene-game-design.md §3–§5):
 *   - §5 zone → bbox mapping table (3×3 grid)
 *   - §4 scene-director LLM contract parsing + validation
 *   - zone-derived regions (default path; vision is optional/edge-side)
 *   - prompt builders for the director LLM
 *
 * Pure module: no Deno / Node / network APIs, so it runs identically under
 * the Deno edge function and under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONE_KEYS,
  ZONE_TO_BBOX,
  DEFAULT_ZONE,
  zoneToBbox,
  normalizeZone,
  clamp01,
  parseSceneDesign,
  parseSceneDesignWithDiagnostics,
  deriveRegionsFromElements,
  buildSceneDirectorSystemPrompt,
  buildSceneDirectorUserPayload,
  isValidSentence,
  validateSentence,
  countMascotPlaceholder,
  replaceMascotPlaceholder,
  MASCOT_PLACEHOLDER,
  stripReasoningBlocks,
  parseStoryboard,
  mapWordToStoryboardSentence,
  splitStoryboardSentences,
  buildFusionResult,
} from '../../supabase/functions/scene-generate/sceneDesign.ts';

const WORDS = [
  { text: 'apple', pos: 'noun', definitionCn: '苹果' },
  { text: 'angry', pos: 'adjective', definitionCn: '愤怒的' },
  { text: 'run', pos: 'verb', definitionCn: '跑' },
  { text: 'quickly', pos: 'adverb', definitionCn: '快速地' },
  { text: 'moon', pos: 'noun', definitionCn: '月亮' },
];

// ----------------------------------------------------------------
// §5 zone → bbox table
// ----------------------------------------------------------------
test('ZONE_KEYS exposes exactly the 9 canonical zones', () => {
  assert.deepEqual([...ZONE_KEYS].sort(), [
    'bottom-center',
    'bottom-left',
    'bottom-right',
    'center',
    'mid-left',
    'mid-right',
    'top-center',
    'top-left',
    'top-right',
  ]);
});

test('ZONE_TO_BBOX matches the §5 table exactly (normalized 0–1, 3×3 grid)', () => {
  assert.deepEqual(ZONE_TO_BBOX['top-left'], { x: 0.05, y: 0.05, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['top-center'], { x: 0.36, y: 0.05, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['top-right'], { x: 0.67, y: 0.05, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['mid-left'], { x: 0.05, y: 0.36, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['center'], { x: 0.36, y: 0.36, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['mid-right'], { x: 0.67, y: 0.36, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['bottom-left'], { x: 0.05, y: 0.67, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['bottom-center'], { x: 0.36, y: 0.67, w: 0.28, h: 0.28 });
  assert.deepEqual(ZONE_TO_BBOX['bottom-right'], { x: 0.67, y: 0.67, w: 0.28, h: 0.28 });
});

test('every zone bbox lies fully inside [0,1] and covers ~28% (loose, elegant spotlight)', () => {
  for (const key of ZONE_KEYS) {
    const b = ZONE_TO_BBOX[key];
    assert.ok(b.x >= 0 && b.y >= 0, `${key} origin must be >= 0`);
    assert.ok(b.x + b.w <= 1.0001, `${key} must fit width`);
    assert.ok(b.y + b.h <= 1.0001, `${key} must fit height`);
    assert.ok(b.w > 0.2 && b.h > 0.2, `${key} should be a comfortably sized spotlight`);
  }
});

test('DEFAULT_ZONE is "center"', () => {
  assert.equal(DEFAULT_ZONE, 'center');
});

// ----------------------------------------------------------------
// zoneToBbox / normalizeZone / clamp01
// ----------------------------------------------------------------
test('zoneToBbox returns the table bbox for each zone', () => {
  for (const key of ZONE_KEYS) {
    assert.deepEqual(zoneToBbox(key), ZONE_TO_BBOX[key]);
  }
});

test('zoneToBbox returns a fresh clone (mutation does not poison the table)', () => {
  const a = zoneToBbox('top-left');
  a.x = 999;
  const b = zoneToBbox('top-left');
  assert.equal(b.x, 0.05);
  assert.deepEqual(ZONE_TO_BBOX['top-left'], { x: 0.05, y: 0.05, w: 0.28, h: 0.28 });
});

test('normalizeZone accepts exact, case-insensitive, and underscore variants', () => {
  assert.equal(normalizeZone('top-left'), 'top-left');
  assert.equal(normalizeZone('Top-Left'), 'top-left');
  assert.equal(normalizeZone('TOP_LEFT'), 'top-left');
  assert.equal(normalizeZone(' top-center '), 'top-center');
  assert.equal(normalizeZone('bottomRight'), 'bottom-right');
});

test('normalizeZone returns null for garbage / non-string', () => {
  assert.equal(normalizeZone(''), null);
  assert.equal(normalizeZone('middle'), null);
  assert.equal(normalizeZone(null), null);
  assert.equal(normalizeZone(undefined), null);
  assert.equal(normalizeZone(42), null);
  assert.equal(normalizeZone({ x: 1 }), null);
});

test('clamp01 clamps into [0,1]', () => {
  assert.equal(clamp01(-5), 0);
  assert.equal(clamp01(0), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(1), 1);
  assert.equal(clamp01(5), 1);
  assert.equal(clamp01(NaN), 0);
});

// ----------------------------------------------------------------
// parseSceneDesign (§4 LLM contract)
// ----------------------------------------------------------------
const VALID_STORYBOARD =
  'A glossy red apple sits on the wooden kitchen counter. ' +
  'The angry chef slams his wooden spoon onto the stove. ' +
  'Two children run across the wet grass after the morning rain. ' +
  'A rabbit darts quickly between the garden flowerpots. ' +
  'A pale crescent moon glows faintly above the rooftop.';

const VALID_DESIGN_JSON = JSON.stringify({
  sceneTitle: 'Cozy Kitchen Morning',
  sceneConcept: 'A leaf-green monster cooks breakfast in a sunny kitchen.',
  storyboard: VALID_STORYBOARD,
  structuredPrompt: 'Isometric cartoon scene of a sunny kitchen, with [TODAYS_MASCOT] standing at the stove flipping pancakes, a glossy apple at top-left, an angry chef at center, a child running bottom-right, a dashing rabbit mid-right, and a crescent moon glowing top-right.',
  elements: [
    { word: 'apple', element: 'a red apple', presentation: 'glossy', positionZone: 'top-left', sentence: 'A glossy red apple sits on the wooden kitchen counter.' },
    { word: 'angry', element: 'a frowning chef', presentation: 'red face', positionZone: 'center', sentence: 'The angry chef slams his wooden spoon onto the stove.' },
    { word: 'run', element: 'a running child', presentation: 'mid-stride', positionZone: 'bottom-right', sentence: 'Two children run across the wet grass after the morning rain.' },
    { word: 'quickly', element: 'a dashing rabbit', presentation: 'speed lines', positionZone: 'mid-right', sentence: 'A rabbit darts quickly between the garden flowerpots.' },
    { word: 'moon', element: 'a crescent moon', presentation: 'glowing', positionZone: 'top-right', sentence: 'A pale crescent moon glows faintly above the rooftop.' },
  ],
});

test('parseSceneDesign parses a clean JSON payload', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS);
  assert.ok(design, 'should parse');
  assert.equal(design!.sceneTitle, 'Cozy Kitchen Morning');
  assert.equal(design!.sceneConcept, 'A leaf-green monster cooks breakfast in a sunny kitchen.');
  assert.ok(design!.structuredPrompt.length > 0);
  assert.equal(design!.elements.length, 5);
  assert.equal(design!.elements[0].word, 'apple');
  assert.equal(design!.elements[0].positionZone, 'top-left');
});

test('parseSceneDesign strips a ```json fenced block', () => {
  const fenced = '```json\n' + VALID_DESIGN_JSON + '\n```';
  const design = parseSceneDesign(fenced, WORDS);
  assert.ok(design);
  assert.equal(design!.elements.length, 5);
});

test('parseSceneDesign extracts JSON embedded in prose', () => {
  const wrapped = 'Sure! Here is the plan:\n' + VALID_DESIGN_JSON + '\nHope this helps!';
  const design = parseSceneDesign(wrapped, WORDS);
  assert.ok(design);
  assert.equal(design!.elements.length, 5);
});

test('parseSceneDesign handles a bare fenced block without language tag', () => {
  const fenced = '```\n' + VALID_DESIGN_JSON + '\n```';
  const design = parseSceneDesign(fenced, WORDS);
  assert.ok(design);
  assert.equal(design!.sceneTitle, 'Cozy Kitchen Morning');
});

test('parseSceneDesign returns null for non-JSON garbage', () => {
  assert.equal(parseSceneDesign('the quick brown fox', WORDS), null);
  assert.equal(parseSceneDesign('', WORDS), null);
  assert.equal(parseSceneDesign('   \n  ', WORDS), null);
});

// ----------------------------------------------------------------
// Reasoning-model <think> blocks (MiniMax M3, DeepSeek R1, etc.)
// ----------------------------------------------------------------
test('parseSceneDesign strips a closed <think>...</think> block before the JSON', () => {
  const withThink = [
    '<think>Let me analyze the inputs:',
    '- Day: Saturday (dayIndex 6)',
    '- Mascot: A sloth-like turquoise monster',
    'I need to place 5 words + mascot in distinct zones.',
    '</think>',
    VALID_DESIGN_JSON,
  ].join('\n');
  const design = parseSceneDesign(withThink, WORDS);
  assert.ok(design, 'should parse despite the <think> prefix');
  assert.equal(design!.sceneTitle, 'Cozy Kitchen Morning');
  assert.equal(design!.elements.length, 5);
});

test('parseSceneDesign handles <think> block that contains JSON-like braces', () => {
  // The reasoning block mentions {zone: "center"} — must not be mistaken for the answer.
  const tricky = [
    '<think>Reasoning about layout.',
    'Maybe I should use {"zone": "center"} for the mascot.',
    'But that\'s just reasoning, not the answer.',
    '</think>',
    VALID_DESIGN_JSON,
  ].join('\n');
  const design = parseSceneDesign(tricky, WORDS);
  assert.ok(design, 'should pick the real design JSON, not the reasoning debris');
  assert.equal(design!.elements.length, 5);
  assert.equal(design!.elements[0].word, 'apple');
});

test('parseSceneDesign handles unclosed <think> (model forgot </think>)', () => {
  const unclosed = [
    '<think>Let me think about this scene.',
    'I need 5 elements in an isometric kitchen.',
    '',
    '{"sceneTitle":"Kitchen","sceneConcept":"morning","structuredPrompt":"isometric scene","elements":[' +
      '{"word":"apple","element":"red apple","positionZone":"top-left"},' +
      '{"word":"angry","element":"chef","positionZone":"center"},' +
      '{"word":"run","element":"running child","positionZone":"bottom-right"},' +
      '{"word":"quickly","element":"rabbit","positionZone":"mid-right"},' +
      '{"word":"moon","element":"crescent moon","positionZone":"top-right"}' +
    ']}',
  ].join('\n');
  const design = parseSceneDesign(unclosed, WORDS);
  assert.ok(design, 'should recover JSON even when <think> is unclosed');
  assert.equal(design!.elements.length, 5);
});

test('stripReasoningBlocks removes closed think blocks', () => {
  const input = '<think>reasoning here</think>\n{"answer": true}';
  assert.equal(stripReasoningBlocks(input), '{"answer": true}');
});

test('stripReasoningBlocks leaves non-think text untouched', () => {
  assert.equal(stripReasoningBlocks('no think tags here'), 'no think tags here');
  assert.equal(stripReasoningBlocks('{"json": true}'), '{"json": true}');
});

test('parseSceneDesign returns null when structuredPrompt is missing/empty', () => {
  const noPrompt = JSON.stringify({ elements: [{ word: 'apple', positionZone: 'center' }] });
  assert.equal(parseSceneDesign(noPrompt, WORDS), null);
  const emptyPrompt = JSON.stringify({ structuredPrompt: '   ', elements: [] });
  assert.equal(parseSceneDesign(emptyPrompt, WORDS), null);
});

test('parseSceneDesign returns null when elements is not an array', () => {
  const bad = JSON.stringify({ structuredPrompt: 'ok', elements: 'nope' });
  assert.equal(parseSceneDesign(bad, WORDS), null);
});

test('parseSceneDesign keeps only elements whose word matches an input word (case-insensitive), trims text', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [
      { word: 'Apple', positionZone: 'top-left' }, // matches "apple"
      { word: 'dragon', positionZone: 'center' }, // hallucinated -> dropped
      { word: 'ANGRY', positionZone: 'mid-left' }, // matches "angry"
      { word: '   run  ', positionZone: 'bottom-center' }, // whitespace
    ],
  });
  const design = parseSceneDesign(payload, WORDS);
  assert.ok(design);
  const words = design!.elements.map((e) => e.word);
  assert.deepEqual(words.sort(), ['angry', 'apple', 'run']);
  assert.equal(design!.elements.find((e) => e.word === 'run')!.positionZone, 'bottom-center');
});

test('parseSceneDesign normalizes each element positionZone to a canonical key or null', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [
      { word: 'apple', positionZone: 'Top-Left' },
      { word: 'angry', positionZone: 'middle' }, // invalid -> null
      { word: 'run' }, // missing -> null
    ],
  });
  const design = parseSceneDesign(payload, WORDS);
  assert.ok(design);
  const byWord = Object.fromEntries(design!.elements.map((e) => [e.word, e.positionZone ?? null]));
  assert.equal(byWord['apple'], 'top-left');
  assert.equal(byWord['angry'], null);
  assert.equal(byWord['run'], null);
});

test('parseSceneDesign tolerates elements being objects that omit word (dropped) without throwing', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [{ positionZone: 'center' }, { word: 'apple', positionZone: 'top-left' }],
  });
  const design = parseSceneDesign(payload, WORDS);
  assert.ok(design);
  assert.equal(design!.elements.length, 1);
  assert.equal(design!.elements[0].word, 'apple');
});

// ----------------------------------------------------------------
// deriveRegionsFromElements (default region source, §5)
// ----------------------------------------------------------------
test('deriveRegionsFromElements yields one region per input word, in input order', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS)!;
  const regions = deriveRegionsFromElements(design, WORDS);
  assert.equal(regions.length, WORDS.length);
  assert.deepEqual(regions.map((r) => r.word), WORDS.map((w) => w.text));
});

test('deriveRegionsFromElements maps each element zone to its §5 bbox', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS)!;
  const regions = deriveRegionsFromElements(design, WORDS);
  const byWord = Object.fromEntries(regions.map((r) => [r.word, r]));
  assert.deepEqual({ x: byWord['apple'].x, y: byWord['apple'].y, w: byWord['apple'].w, h: byWord['apple'].h }, ZONE_TO_BBOX['top-left']);
  assert.deepEqual({ x: byWord['angry'].x, y: byWord['angry'].y, w: byWord['angry'].w, h: byWord['angry'].h }, ZONE_TO_BBOX['center']);
  assert.deepEqual({ x: byWord['moon'].x, y: byWord['moon'].y, w: byWord['moon'].w, h: byWord['moon'].h }, ZONE_TO_BBOX['top-right']);
});

test('deriveRegionsFromElements falls back to center zone when element/zone missing (source=default)', () => {
  const design = parseSceneDesign(
    JSON.stringify({
      structuredPrompt: 'ok',
      elements: [{ word: 'apple', positionZone: 'top-left' }],
    }),
    WORDS,
  )!;
  const regions = deriveRegionsFromElements(design, WORDS);
  const byWord = Object.fromEntries(regions.map((r) => [r.word, r]));
  // apple has a real zone
  assert.equal(byWord['apple'].source, 'zone');
  assert.deepEqual({ x: byWord['apple'].x, y: byWord['apple'].y, w: byWord['apple'].w, h: byWord['apple'].h }, ZONE_TO_BBOX['top-left']);
  // the rest fall back to center
  for (const w of ['angry', 'run', 'quickly', 'moon']) {
    assert.equal(byWord[w].source, 'default', `${w} should be default`);
    assert.deepEqual({ x: byWord[w].x, y: byWord[w].y, w: byWord[w].w, h: byWord[w].h }, ZONE_TO_BBOX['center']);
  }
});

test('every derived region bbox is normalized to [0,1] and never marked detection-failed by the zone path', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS)!;
  const regions = deriveRegionsFromElements(design, WORDS);
  for (const r of regions) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, `${r.word} out of bounds`);
    // zone path must render as a spotlight box (never whole-image pulse)
    assert.ok(r.confidence >= 0.4, `${r.word} confidence ${r.confidence} must be >= 0.4 so it is not flagged detectionFailed`);
    assert.equal('detectionFailed' in r && (r as any).detectionFailed === true, false);
  }
});

test('deriveRegionsFromElements handles empty elements (all default-center)', () => {
  const design = { structuredPrompt: 'fallback', elements: [] as any[] };
  const regions = deriveRegionsFromElements(design, WORDS);
  assert.equal(regions.length, WORDS.length);
  for (const r of regions) {
    assert.equal(r.source, 'default');
    assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, ZONE_TO_BBOX['center']);
  }
});

test('deriveRegionsFromElements is deterministic (same input → same output)', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS)!;
  const a = deriveRegionsFromElements(design, WORDS);
  const b = deriveRegionsFromElements(design, WORDS);
  assert.deepEqual(a, b);
});

// ----------------------------------------------------------------
// isValidSentence (cloze-sentence validation)
// ----------------------------------------------------------------
test('isValidSentence accepts a natural sentence containing the target word', () => {
  assert.equal(isValidSentence('A glossy red apple sits on the wooden kitchen counter.', 'apple'), true);
  assert.equal(isValidSentence('The angry chef slams his wooden spoon onto the stove.', 'angry'), true);
  assert.equal(isValidSentence('A child runs across the wet grass after the morning rain.', 'run'), false); // "run" not "runs" — only verbatim matches
  // Verbatim variant of `run`:
  assert.equal(isValidSentence('You should run a mile every morning before breakfast.', 'run'), true);
});

test('isValidSentence matches case-insensitively and at sentence boundaries', () => {
  assert.equal(isValidSentence('Apple is my favorite fruit.', 'apple'), true);
  assert.equal(isValidSentence('RUN as fast as you can.', 'run'), true);
  assert.equal(isValidSentence('Quickly, the rabbit darts away.', 'quickly'), true);
});

test('isValidSentence rejects substrings of larger tokens (no "apple" inside "applesauce")', () => {
  assert.equal(isValidSentence('I love applesauce on toast.', 'apple'), false);
  assert.equal(isValidSentence('The runaway train derailed.', 'run'), false);
});

test('isValidSentence handles adjacent punctuation ("apple," / "apple.")', () => {
  assert.equal(isValidSentence('She picked up the apple, then walked away.', 'apple'), true);
  assert.equal(isValidSentence('I ate the apple.', 'apple'), true);
});

test('isValidSentence rejects "The word is X" lazy templates', () => {
  assert.equal(isValidSentence('The word is apple.', 'apple'), false);
  assert.equal(isValidSentence('The word is "apple".', 'apple'), false);
});

test('isValidSentence rejects "X means ..." definition openers', () => {
  assert.equal(isValidSentence('Apple means a round red fruit.', 'apple'), false);
  assert.equal(isValidSentence('means a red fruit', 'apple'), false);
});

test('isValidSentence rejects too-short and too-long sentences', () => {
  // Below min length (5 chars):
  assert.equal(isValidSentence('ok', 'apple'), false);
  assert.equal(isValidSentence('the', 'apple'), false); // 'the' doesn't contain apple anyway
  // Over max length (300 chars):
  const long = ('an apple rests here. ' + 'a'.repeat(20)).repeat(15);
  assert.equal(isValidSentence(long, 'apple'), false);
});

test('isValidSentence rejects non-string types and missing word', () => {
  assert.equal(isValidSentence(undefined, 'apple'), false);
  assert.equal(isValidSentence(null, 'apple'), false);
  assert.equal(isValidSentence(42, 'apple'), false);
  assert.equal(isValidSentence('An apple sits here.', ''), false);
});

// ----------------------------------------------------------------
// parseSceneDesign: sentence handling
// ----------------------------------------------------------------
test('parseSceneDesign accepts a valid cloze sentence per element', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS)!;
  for (const el of design.elements) {
    assert.ok(typeof el.sentence === 'string' && el.sentence.length > 0, `${el.word} should carry a sentence`);
  }
  assert.equal(design.elements[0].sentence, 'A glossy red apple sits on the wooden kitchen counter.');
});

test('parseSceneDesign drops only the sentence field when it does not contain the word', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [
      // "horse" does not appear in the sentence → sentence dropped, element kept
      { word: 'apple', positionZone: 'top-left', sentence: 'A horse gallops across the field.' },
      // valid sentence → kept
      { word: 'angry', positionZone: 'center', sentence: 'The angry chef slams his spoon down.' },
    ],
  });
  const design = parseSceneDesign(payload, WORDS)!;
  assert.equal(design.elements.length, 2);
  const apple = design.elements.find((e) => e.word === 'apple')!;
  assert.equal(apple.sentence, undefined, 'apple.sentence must be dropped');
  const angry = design.elements.find((e) => e.word === 'angry')!;
  assert.equal(angry.sentence, 'The angry chef slams his spoon down.');
});

test('parseSceneDesign drops "The word is X" templated sentences', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [
      { word: 'apple', positionZone: 'top-left', sentence: 'The word is apple.' },
      { word: 'angry', positionZone: 'center', sentence: 'Angry means feeling mad.' },
    ],
  });
  const design = parseSceneDesign(payload, WORDS)!;
  assert.equal(design.elements.find((e) => e.word === 'apple')!.sentence, undefined);
  assert.equal(design.elements.find((e) => e.word === 'angry')!.sentence, undefined);
});

test('parseSceneDesign matches the word case-insensitively when validating sentence', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [
      { word: 'apple', positionZone: 'top-left', sentence: 'An APPLE rests on the counter.' },
    ],
  });
  const design = parseSceneDesign(payload, WORDS)!;
  assert.equal(design.elements[0].sentence, 'An APPLE rests on the counter.');
});

test('parseSceneDesign handles missing sentence gracefully (no field = no error)', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'ok',
    elements: [
      { word: 'apple', positionZone: 'top-left' }, // no sentence field
    ],
  });
  const design = parseSceneDesign(payload, WORDS)!;
  assert.equal(design.elements.length, 1);
  assert.equal(design.elements[0].sentence, undefined);
});

// ----------------------------------------------------------------
// deriveRegionsFromElements: sentence passthrough
// ----------------------------------------------------------------
test('deriveRegionsFromElements carries the element sentence through to the region', () => {
  const design = parseSceneDesign(VALID_DESIGN_JSON, WORDS)!;
  const regions = deriveRegionsFromElements(design, WORDS);
  const byWord = Object.fromEntries(regions.map((r) => [r.word, r]));
  assert.equal(byWord['apple'].sentence, 'A glossy red apple sits on the wooden kitchen counter.');
  assert.equal(byWord['moon'].sentence, 'A pale crescent moon glows faintly above the rooftop.');
});

test('deriveRegionsFromElements omits sentence on regions whose element lacks one', () => {
  const design = parseSceneDesign(
    JSON.stringify({
      structuredPrompt: 'ok',
      elements: [{ word: 'apple', positionZone: 'top-left' }],
    }),
    WORDS,
  )!;
  const regions = deriveRegionsFromElements(design, WORDS);
  const apple = regions.find((r) => r.word === 'apple')!;
  assert.equal(apple.sentence, undefined);
  // word without an element → falls back to center, no sentence
  const angry = regions.find((r) => r.word === 'angry')!;
  assert.equal(angry.source, 'default');
  assert.equal(angry.sentence, undefined);
});

// ----------------------------------------------------------------
// Diagnostics (parseSceneDesignWithDiagnostics)
// ----------------------------------------------------------------
test('parseSceneDesignWithDiagnostics returns full diagnostics on a clean parse', () => {
  const { design, diagnostics } = parseSceneDesignWithDiagnostics(VALID_DESIGN_JSON, WORDS);
  assert.ok(design);
  assert.equal(diagnostics.parsedSuccessfully, true);
  assert.equal(diagnostics.failReason, undefined);
  assert.equal(diagnostics.totalElements, 5);
  assert.equal(diagnostics.inputWordCount, 5);
  assert.equal(diagnostics.zonesAssigned, 5);
  assert.equal(diagnostics.validSentences, 5);
  assert.equal(diagnostics.droppedSentences, 0);
  assert.deepEqual(diagnostics.dropReasons, {
    notString: 0, tooShort: 0, tooLong: 0, missingWord: 0, lazyTemplate: 0, meansOpener: 0,
  });
  assert.deepEqual(diagnostics.missingSentenceFields, []);
  assert.equal(diagnostics.thinkBlockStripped, false);
  assert.equal(diagnostics.fenceBlockStripped, false);
  assert.equal(diagnostics.jsonExtractedFromProse, false);
  assert.equal(diagnostics.mascotPlaceholder.used, true);
  assert.equal(diagnostics.mascotPlaceholder.count, 1);
  assert.equal(diagnostics.mascotPlaceholder.replacedInStructuredPrompt, false);
  // Storyboard fields (§4 storyboard-first refactor)
  assert.equal(diagnostics.storyboardPresent, true);
  assert.ok(diagnostics.storyboardLength > 50);
  assert.equal(diagnostics.storyboardSentenceCount, 5);
  assert.equal(diagnostics.storyboardWordCoverage, 5);
  assert.equal(diagnostics.storyboardViolation, null);
  assert.ok(design!.storyboard);
  assert.equal(design!.storyboard, VALID_STORYBOARD);
  assert.ok(diagnostics.rawContentLength > 100);
});

test('parseSceneDesignWithDiagnostics flags <think> block and prose extraction', () => {
  // Wrapped: <think> prefix + prose + fenced JSON. The fence regex only fires
  // when the fence spans the whole string, so embedded fences don't count.
  const wrapped = [
    '<think>planning the scene...</think>',
    'Sure! Here you go:',
    '```json',
    VALID_DESIGN_JSON,
    '```',
  ].join('\n');
  const { diagnostics } = parseSceneDesignWithDiagnostics(wrapped, WORDS);
  assert.equal(diagnostics.parsedSuccessfully, true);
  assert.equal(diagnostics.thinkBlockStripped, true);
  assert.equal(diagnostics.fenceBlockStripped, false); // fence was embedded, not whole-string
  assert.equal(diagnostics.jsonExtractedFromProse, true);
});

test('parseSceneDesignWithDiagnostics flags whole-string fence stripping', () => {
  // Pure fenced JSON (no prose prefix) → fenceStripped=true, proseExtracted=false.
  const fenced = '```json\n' + VALID_DESIGN_JSON + '\n```';
  const { diagnostics } = parseSceneDesignWithDiagnostics(fenced, WORDS);
  assert.equal(diagnostics.parsedSuccessfully, true);
  assert.equal(diagnostics.fenceBlockStripped, true);
  assert.equal(diagnostics.jsonExtractedFromProse, false); // clean JSON.parse after defencing
});

test('parseSceneDesignWithDiagnostics reports per-reason sentence drop counts', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'scene with [TODAYS_MASCOT] looking on',
    elements: [
      // valid
      { word: 'apple', positionZone: 'top-left', sentence: 'A red apple sits on the counter.' },
      // missingWord: sentence doesn't contain "angry"
      { word: 'angry', positionZone: 'center', sentence: 'The chef slams his spoon down.' },
      // lazyTemplate
      { word: 'run', positionZone: 'bottom-right', sentence: 'The word is run.' },
      // tooShort
      { word: 'quickly', positionZone: 'mid-right', sentence: 'ok' },
      // meansOpener
      { word: 'moon', positionZone: 'top-right', sentence: 'Moon means a celestial body.' },
    ],
  });
  const { diagnostics } = parseSceneDesignWithDiagnostics(payload, WORDS);
  assert.equal(diagnostics.parsedSuccessfully, true);
  assert.equal(diagnostics.totalElements, 5);
  assert.equal(diagnostics.validSentences, 1);
  assert.equal(diagnostics.droppedSentences, 4);
  assert.equal(diagnostics.dropReasons.missingWord, 1);
  assert.equal(diagnostics.dropReasons.lazyTemplate, 1);
  assert.equal(diagnostics.dropReasons.tooShort, 1);
  assert.equal(diagnostics.dropReasons.meansOpener, 1);
  assert.deepEqual(diagnostics.missingSentenceFields.sort(), ['angry', 'moon', 'quickly', 'run']);
});

test('parseSceneDesignWithDiagnostics returns failReason on garbage input', () => {
  const { design, diagnostics } = parseSceneDesignWithDiagnostics('not even json', WORDS);
  assert.equal(design, null);
  assert.equal(diagnostics.parsedSuccessfully, false);
  assert.equal(diagnostics.failReason, 'unparseable-json');
  assert.equal(diagnostics.inputWordCount, 5);
  assert.equal(diagnostics.rawContentLength > 0, true);
});

test('parseSceneDesignWithDiagnostics returns failReason on empty input', () => {
  const { design, diagnostics } = parseSceneDesignWithDiagnostics('', WORDS);
  assert.equal(design, null);
  assert.equal(diagnostics.failReason, 'empty-input');
});

test('parseSceneDesignWithDiagnostics returns failReason when structuredPrompt is missing', () => {
  const { design, diagnostics } = parseSceneDesignWithDiagnostics(
    JSON.stringify({ elements: [{ word: 'apple', positionZone: 'center' }] }),
    WORDS,
  );
  assert.equal(design, null);
  assert.equal(diagnostics.failReason, 'no-structured-prompt');
});

test('parseSceneDesignWithDiagnostics returns failReason when elements is not an array', () => {
  const { design, diagnostics } = parseSceneDesignWithDiagnostics(
    JSON.stringify({ structuredPrompt: 'ok', elements: 'nope' }),
    WORDS,
  );
  assert.equal(design, null);
  assert.equal(diagnostics.failReason, 'elements-not-array');
});

test('parseSceneDesignWithDiagnostics counts zonesAssigned only for valid zones', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'scene with [TODAYS_MASCOT]',
    elements: [
      { word: 'apple', positionZone: 'top-left' },
      { word: 'angry', positionZone: 'middle' }, // invalid → not counted
      { word: 'run' }, // missing → not counted
    ],
  });
  const { diagnostics } = parseSceneDesignWithDiagnostics(payload, WORDS);
  assert.equal(diagnostics.parsedSuccessfully, true);
  assert.equal(diagnostics.totalElements, 3);
  assert.equal(diagnostics.zonesAssigned, 1); // only apple
});

test('parseSceneDesignWithDiagnostics tracks mascot placeholder count in prompt', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'Scene: [TODAYS_MASCOT] at the stove, plus another [TODAYS_MASCOT] in the garden.',
    elements: [{ word: 'apple', positionZone: 'top-left', sentence: 'An apple rests on the table.' }],
  });
  const { diagnostics } = parseSceneDesignWithDiagnostics(payload, WORDS);
  assert.equal(diagnostics.mascotPlaceholder.used, true);
  assert.equal(diagnostics.mascotPlaceholder.count, 2);
});

test('parseSceneDesignWithDiagnostics detects zero mascot placeholders (LLM forgot)', () => {
  const payload = JSON.stringify({
    structuredPrompt: 'A scene with a red monster at the stove, no placeholder used.',
    elements: [{ word: 'apple', positionZone: 'top-left', sentence: 'An apple rests on the table.' }],
  });
  const { diagnostics } = parseSceneDesignWithDiagnostics(payload, WORDS);
  assert.equal(diagnostics.mascotPlaceholder.used, false);
  assert.equal(diagnostics.mascotPlaceholder.count, 0);
});

// ----------------------------------------------------------------
// Mascot placeholder helpers (countMascotPlaceholder / replaceMascotPlaceholder)
// ----------------------------------------------------------------
test('MASCOT_PLACEHOLDER exports the canonical token', () => {
  assert.equal(MASCOT_PLACEHOLDER, '[TODAYS_MASCOT]');
});

test('countMascotPlaceholder returns 0 for strings without the token', () => {
  assert.equal(countMascotPlaceholder(''), 0);
  assert.equal(countMascotPlaceholder('a normal sentence'), 0);
  assert.equal(countMascotPlaceholder('[TODAY_MASCOT]'), 0); // wrong spelling
});

test('countMascotPlaceholder returns N for N occurrences', () => {
  assert.equal(countMascotPlaceholder('[TODAYS_MASCOT]'), 1);
  assert.equal(countMascotPlaceholder('a [TODAYS_MASCOT] b [TODAYS_MASCOT] c'), 2);
  assert.equal(countMascotPlaceholder('[[TODAYS_MASCOT]]'), 1); // brackets on both sides still count once
});

test('replaceMascotPlaceholder returns identical string + count=0 when no token present', () => {
  const r = replaceMascotPlaceholder('a cozy kitchen', 'a friendly monster');
  assert.equal(r.prompt, 'a cozy kitchen');
  assert.equal(r.replacedCount, 0);
});

test('replaceMascotPlaceholder substitutes every occurrence and counts them', () => {
  const r = replaceMascotPlaceholder(
    'kitchen with [TODAYS_MASCOT] at the stove and [TODAYS_MASCOT] in the garden',
    'a small electric-blue monster',
  );
  assert.equal(r.prompt, 'kitchen with a small electric-blue monster at the stove and a small electric-blue monster in the garden');
  assert.equal(r.replacedCount, 2);
});

test('replaceMascotPlaceholder handles non-string / empty input safely', () => {
  // @ts-expect-error testing runtime safety
  const r1 = replaceMascotPlaceholder(null, 'x');
  assert.equal(r1.replacedCount, 0);
  const r2 = replaceMascotPlaceholder('', 'x');
  assert.equal(r2.replacedCount, 0);
  assert.equal(r2.prompt, '');
});

// ----------------------------------------------------------------
// validateSentence (returns reason, complements isValidSentence boolean)
// ----------------------------------------------------------------
test('validateSentence returns null for valid sentences', () => {
  assert.equal(validateSentence('A glossy red apple sits on the wooden kitchen counter.', 'apple'), null);
});

test('validateSentence returns the first failing reason', () => {
  assert.equal(validateSentence(undefined, 'apple'), 'notString');
  assert.equal(validateSentence(null, 'apple'), 'notString');
  assert.equal(validateSentence(42, 'apple'), 'notString');
  assert.equal(validateSentence('ok', 'apple'), 'tooShort');
  assert.equal(validateSentence('apple.', 'apple'), null); // 6 chars, valid
  assert.equal(validateSentence('the', 'apple'), 'tooShort');
  assert.equal(validateSentence('The word is apple.', 'apple'), 'lazyTemplate');
  assert.equal(validateSentence('Apple means a fruit.', 'apple'), 'meansOpener');
  assert.equal(validateSentence('A red fruit sits here.', 'apple'), 'missingWord');
});

// ----------------------------------------------------------------
// Prompt builders (§4.1 / §4.2)
// ----------------------------------------------------------------
test('buildSceneDirectorSystemPrompt enumerates all 9 zones and the core directives', () => {
  const sys = buildSceneDirectorSystemPrompt();
  for (const key of ZONE_KEYS) assert.ok(sys.includes(key), `system prompt must list zone ${key}`);
  assert.ok(/positionZone/i.test(sys));
  assert.ok(/isometric/i.test(sys));
  assert.ok(/json/i.test(sys));
  assert.ok(/watermark|caption/i.test(sys));
  assert.ok(/mascot/i.test(sys));
});

test('buildSceneDirectorSystemPrompt instructs the model to emit a cloze `sentence` per element', () => {
  const sys = buildSceneDirectorSystemPrompt();
  assert.ok(/sentence/i.test(sys), 'system prompt must mention sentence');
  assert.ok(/the word is/i.test(sys), 'system prompt must call out the "The word is X" anti-pattern');
  assert.ok(/verbatim/i.test(sys), 'system prompt must require the word verbatim');
  // The JSON schema line uses `"sentence": string` (with optional whitespace);
  // allow either the compact form (legacy) or the readable form (current).
  assert.ok(/"sentence":\s*string/.test(sys), 'JSON schema must include sentence field');
});

test('buildSceneDirectorSystemPrompt instructs the model to use the [TODAYS_MASCOT] placeholder', () => {
  const sys = buildSceneDirectorSystemPrompt();
  assert.ok(sys.includes('[TODAYS_MASCOT]'), 'system prompt must mention the placeholder verbatim');
  assert.ok(/reference image/i.test(sys), 'system prompt must explain why we use a reference image');
  assert.ok(/EXACTLY ONE/i.test(sys), 'system prompt must require exactly one occurrence');
});

test('buildSceneDirectorUserPayload carries every word + day index + monster prose', () => {
  const prose = 'A cute red monster for Sunday.';
  const payload = buildSceneDirectorUserPayload(WORDS, 0, prose);
  assert.equal(payload.dayIndex, 0);
  assert.equal(payload.monsterProse, prose);
  assert.equal(payload.words.length, WORDS.length);
  for (const w of WORDS) {
    const match = payload.words.find((p: any) => p.text === w.text);
    assert.ok(match, `payload must include ${w.text}`);
    assert.equal(match.pos, w.pos);
    assert.equal(match.definitionCn, w.definitionCn);
  }
});

test('buildSceneDirectorUserPayload clones word data (no shared references)', () => {
  const input = [{ text: 'apple', pos: 'noun', definitionCn: '苹果' }];
  const payload = buildSceneDirectorUserPayload(input, 2, 'monster');
  assert.notEqual(payload.words[0], input[0]);
  payload.words[0].text = 'mutated';
  assert.equal(input[0].text, 'apple');
});

// ----------------------------------------------------------------
// Storyboard parser (§4 storyboard-first refactor)
// ----------------------------------------------------------------
test('splitStoryboardSentences splits on sentence-end punctuation', () => {
  const sentences = splitStoryboardSentences('A small house sits on a hill. It has rained all night. The moon rises.');
  assert.deepEqual(sentences, [
    'A small house sits on a hill',
    'It has rained all night',
    'The moon rises',
  ]);
});

test('splitStoryboardSentences returns [] for empty / non-string input', () => {
  assert.deepEqual(splitStoryboardSentences(''), []);
  assert.deepEqual(splitStoryboardSentences('   \n  '), []);
  // @ts-expect-error runtime safety
  assert.deepEqual(splitStoryboardSentences(null), []);
  // @ts-expect-error runtime safety
  assert.deepEqual(splitStoryboardSentences(undefined), []);
});

test('parseStoryboard accepts a valid 5-word / 5-sentence storyboard', () => {
  const result = parseStoryboard(VALID_STORYBOARD, WORDS);
  assert.equal(result.violation, null);
  assert.equal(result.wordCoverage, 5);
  assert.equal(result.sentences.length, 5);
});

test('parseStoryboard accepts a 6-word storyboard with some 2-word sentences', () => {
  const six = [
    { text: 'house', pos: 'noun', definitionCn: '房子' },
    { text: 'rain', pos: 'noun', definitionCn: '雨' },
    { text: 'angry', pos: 'adjective', definitionCn: '愤怒的' },
    { text: 'run', pos: 'verb', definitionCn: '跑' },
    { text: 'moon', pos: 'noun', definitionCn: '月亮' },
    { text: 'fountain', pos: 'noun', definitionCn: '喷泉' },
  ];
  const storyboard =
    'A small wooden house stands beside a dry fountain on a misty mountain. ' +
    'An angry monster leans at the door while the rain pours down. ' +
    'A pale moon rises as the children run home before dawn.';
  const result = parseStoryboard(storyboard, six);
  assert.equal(result.violation, null);
  assert.equal(result.wordCoverage, 6);
  assert.equal(result.sentences.length, 3);
});

test('parseStoryboard flags too-few-sentences (below ⌈N/2⌉)', () => {
  // 6 words → need ≥ 3 sentences; we have only 2.
  const six = [
    { text: 'house', pos: 'noun', definitionCn: '房子' },
    { text: 'rain', pos: 'noun', definitionCn: '雨' },
    { text: 'angry', pos: 'adjective', definitionCn: '愤怒的' },
    { text: 'run', pos: 'verb', definitionCn: '跑' },
    { text: 'moon', pos: 'noun', definitionCn: '月亮' },
    { text: 'fountain', pos: 'noun', definitionCn: '喷泉' },
  ];
  const result = parseStoryboard('A house is wet. It has rained.', six);
  assert.equal(result.violation, 'too-few-sentences');
});

test('parseStoryboard flags too-many-sentences (above N)', () => {
  // 5 words → max 5 sentences; we have 6.
  const result = parseStoryboard(
    'A house. It rains. Anger. Run. The moon. The fountain.',
    WORDS,
  );
  assert.equal(result.violation, 'too-many-sentences');
});

test('parseStoryboard flags sentence-without-words (a sentence has 0 target words)', () => {
  // 5 sentences, but one sentence has no target words.
  const storyboard =
    'A glossy red apple sits on the counter. ' +
    'There is dust everywhere in the kitchen. ' + // no target words
    'Two children run across the wet grass. ' +
    'A rabbit darts quickly between the pots. ' +
    'A pale crescent moon glows faintly above.';
  const result = parseStoryboard(storyboard, WORDS);
  assert.equal(result.violation, 'sentence-without-words');
});

test('parseStoryboard flags sentence-with-too-many-words (a sentence has 3+ target words)', () => {
  // Sentence 3 contains "run", "quickly", and "moon" → 3 words, violation.
  const storyboard =
    'A glossy red apple sits on the counter. ' +
    'The angry chef slams his spoon onto the stove. ' +
    'Two children run quickly past a pale moon. ' +
    'A rabbit darts between the garden flowerpots. ' +
    'The rooftop glows in the night.';
  const result = parseStoryboard(storyboard, WORDS);
  assert.equal(result.violation, 'sentence-with-too-many-words');
});

test('parseStoryboard flags uncovered-word (some input word is missing)', () => {
  // 5 words, 4 sentences — every sentence contains exactly one word, but
  // "moon" never appears in the storyboard.
  const storyboard =
    'A glossy red apple sits on the counter. ' +
    'The angry chef slams his spoon onto the stove. ' +
    'Two children run across the wet grass. ' +
    'A rabbit darts quickly between the pots.';
  const result = parseStoryboard(storyboard, WORDS);
  assert.equal(result.violation, 'uncovered-word');
  assert.equal(result.wordCoverage, 4);
});

test('parseStoryboard returns too-few-sentences for empty / non-string storyboard', () => {
  assert.equal(parseStoryboard('', WORDS).violation, 'too-few-sentences');
  assert.equal(parseStoryboard('   ', WORDS).violation, 'too-few-sentences');
  // @ts-expect-error runtime safety
  assert.equal(parseStoryboard(null, WORDS).violation, 'too-few-sentences');
});

test('parseStoryboard accepts the canonical 6-word example from the system prompt', () => {
  const six = [
    { text: 'house', pos: 'noun', definitionCn: '房子' },
    { text: 'rain', pos: 'noun', definitionCn: '雨' },
    { text: 'angry', pos: 'adjective', definitionCn: '愤怒的' },
    { text: 'run', pos: 'verb', definitionCn: '跑' },
    { text: 'moon', pos: 'noun', definitionCn: '月亮' },
    { text: 'fountain', pos: 'noun', definitionCn: '喷泉' },
  ];
  const storyboard =
    'A small wooden house sits on a misty mountain. ' +
    'An angry monster leans at the door while the rain pours down. ' +
    'A pale moon rises over a dry fountain. ' +
    'The children run home before dawn.';
  const result = parseStoryboard(storyboard, six);
  assert.equal(result.violation, null);
  assert.equal(result.wordCoverage, 6);
});

// ----------------------------------------------------------------
// mapWordToStoryboardSentence (§4 storyboard → sentence mapping)
// ----------------------------------------------------------------
test('mapWordToStoryboardSentence returns the sentence containing the word', () => {
  assert.equal(
    mapWordToStoryboardSentence(VALID_STORYBOARD, 'apple'),
    'A glossy red apple sits on the wooden kitchen counter',
  );
  assert.equal(
    mapWordToStoryboardSentence(VALID_STORYBOARD, 'moon'),
    'A pale crescent moon glows faintly above the rooftop',
  );
});

test('mapWordToStoryboardSentence matches case-insensitively', () => {
  assert.equal(
    mapWordToStoryboardSentence(VALID_STORYBOARD, 'APPLE'),
    'A glossy red apple sits on the wooden kitchen counter',
  );
});

test('mapWordToStoryboardSentence returns null for word not in storyboard', () => {
  assert.equal(mapWordToStoryboardSentence(VALID_STORYBOARD, 'house'), null);
});

test('mapWordToStoryboardSentence returns null when no sentence uniquely contains the word', () => {
  // A storyboard where "apple" appears in two sentences — ambiguous.
  const dup =
    'A red apple sits on the counter. ' +
    'The apple also sits on the shelf.';
  assert.equal(mapWordToStoryboardSentence(dup, 'apple'), null);
});

test('mapWordToStoryboardSentence returns null for empty / non-string storyboard', () => {
  assert.equal(mapWordToStoryboardSentence('', 'apple'), null);
  // @ts-expect-error runtime safety
  assert.equal(mapWordToStoryboardSentence(null, 'apple'), null);
});

// ----------------------------------------------------------------
// buildFusionResult (deterministic fallback — must always include storyboard + sentences)
// ----------------------------------------------------------------
test('buildFusionResult emits N sentences, one per input word', () => {
  const result = buildFusionResult(WORDS, 0);
  assert.equal(result.sentences.length, WORDS.length);
  for (let i = 0; i < WORDS.length; i++) {
    assert.equal(result.sentences[i].word, WORDS[i].text);
    assert.ok(result.sentences[i].sentence.length > 0);
  }
});

test('buildFusionResult storyboard passes its own parseStoryboard validation', () => {
  const result = buildFusionResult(WORDS, 0);
  const parsed = parseStoryboard(result.storyboard, WORDS);
  assert.equal(parsed.violation, null, `fallback storyboard failed validation: ${parsed.violation}`);
  assert.equal(parsed.wordCoverage, WORDS.length);
  // Sentence count is exactly N (one per word).
  assert.equal(parsed.sentences.length, WORDS.length);
});

test('buildFusionResult sentences all pass isValidSentence (contain the word verbatim)', () => {
  const result = buildFusionResult(WORDS, 2);
  for (let i = 0; i < WORDS.length; i++) {
    assert.equal(
      isValidSentence(result.sentences[i].sentence, WORDS[i].text),
      true,
      `${WORDS[i].text}: ${result.sentences[i].sentence}`,
    );
  }
});

test('buildFusionResult image prompt is non-empty and mentions every word', () => {
  const result = buildFusionResult(WORDS, 1);
  assert.ok(result.prompt.length > 50);
  for (const w of WORDS) {
    assert.ok(result.prompt.includes(w.text), `prompt must mention ${w.text}`);
  }
});

test('buildFusionResult handles empty words array gracefully', () => {
  const result = buildFusionResult([], 0);
  assert.equal(result.sentences.length, 0);
  assert.equal(result.storyboard, '');
  assert.ok(result.prompt.length > 0);
});

// ----------------------------------------------------------------
// System prompt — storyboard-first 4-stage structure (§4 refactor)
// ----------------------------------------------------------------
test('buildSceneDirectorSystemPrompt includes a 4-stage storyboard-first structure', () => {
  const sys = buildSceneDirectorSystemPrompt();
  assert.ok(/STAGE 1/.test(sys), 'must label the storyboard stage');
  assert.ok(/STAGE 2/.test(sys), 'must label the metadata stage');
  assert.ok(/STAGE 3/.test(sys), 'must label the image prompt stage');
  assert.ok(/STAGE 4/.test(sys), 'must label the cloze sentence stage');
  assert.ok(/storyboard/i.test(sys), 'must mention storyboard by name');
  // The prompt must constrain sentence-per-word counts.
  assert.ok(/1\s*[-–]\s*2/.test(sys) || /1 or 2/i.test(sys), 'must constrain per-sentence word count to 1–2');
  // Sentence-count constraint ⌈N/2⌉–N.
  assert.ok(/⌈N\/2⌉|ceil\(N\/2\)|N\/2/i.test(sys), 'must specify ⌈N/2⌉ minimum sentence count');
});

test('buildSceneDirectorSystemPrompt declares storyboard as a top-level JSON field', () => {
  const sys = buildSceneDirectorSystemPrompt();
  assert.ok(/"storyboard":\s*string/i.test(sys), 'JSON schema must include storyboard:string');
});

test('parseSceneDesignWithDiagnostics fails with storyboard-invalid when storyboard is present but violates constraints', () => {
  // Structured prompt + valid elements + valid cloze sentences, but a storyboard
  // missing one word ("moon") → must fail with storyboard-invalid.
  const storyboardNoMoon =
    'A glossy red apple sits on the counter. ' +
    'The angry chef slams his spoon onto the stove. ' +
    'Two children run across the wet grass. ' +
    'A rabbit darts quickly between the pots.';
  const payload = JSON.stringify({
    storyboard: storyboardNoMoon,
    structuredPrompt: 'isometric kitchen with [TODAYS_MASCOT]',
    elements: [
      { word: 'apple', positionZone: 'top-left', sentence: 'A glossy red apple sits on the counter.' },
      { word: 'angry', positionZone: 'center', sentence: 'The angry chef slams his spoon onto the stove.' },
      { word: 'run', positionZone: 'bottom-right', sentence: 'Two children run across the wet grass.' },
      { word: 'quickly', positionZone: 'mid-right', sentence: 'A rabbit darts quickly between the pots.' },
      { word: 'moon', positionZone: 'top-right', sentence: 'A bright light glows faintly above the rooftop.' },
    ],
  });
  const { design, diagnostics } = parseSceneDesignWithDiagnostics(payload, WORDS);
  assert.equal(design, null);
  assert.equal(diagnostics.parsedSuccessfully, false);
  assert.equal(diagnostics.failReason, 'storyboard-invalid');
  assert.equal(diagnostics.storyboardPresent, true);
  assert.equal(diagnostics.storyboardWordCoverage, 4);
  assert.equal(diagnostics.storyboardViolation, 'uncovered-word');
});
