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
  deriveRegionsFromElements,
  buildSceneDirectorSystemPrompt,
  buildSceneDirectorUserPayload,
  stripReasoningBlocks,
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
const VALID_DESIGN_JSON = JSON.stringify({
  sceneTitle: 'Cozy Kitchen Morning',
  sceneConcept: 'A leaf-green monster cooks breakfast in a sunny kitchen.',
  structuredPrompt: 'Isometric cartoon scene ... apple at top-left; angry chef at center.',
  elements: [
    { word: 'apple', element: 'a red apple', presentation: 'glossy', positionZone: 'top-left' },
    { word: 'angry', element: 'a frowning chef', presentation: 'red face', positionZone: 'center' },
    { word: 'run', element: 'a running child', presentation: 'mid-stride', positionZone: 'bottom-right' },
    { word: 'quickly', element: 'a dashing rabbit', presentation: 'speed lines', positionZone: 'mid-right' },
    { word: 'moon', element: 'a crescent moon', presentation: 'glowing', positionZone: 'top-right' },
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
