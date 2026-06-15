// ================================================================
// sceneDesign.ts — pure logic for the Scene Fusion Game pipeline.
//
// ZERO imports (no Deno / Node / network APIs), so it runs identically
// under the Deno edge function (supabase/functions/scene-generate) and
// under `node --test` (TypeScript type-stripping). This file is the
// single source of truth for:
//   - §5 positionZone → bbox mapping (the DEFAULT region source)
//   - §4 scene-director LLM contract parsing + validation
//   - zone-derived regions (buildFusionPrompt is only a fallback)
//   - the scene-director system / user prompt builders
//
// Keep it dependency-free. Anything that needs fetch/env lives in index.ts.
// ================================================================

// ----------------------------------------------------------------
// §5 positionZone → bbox (normalized 0–1, 3×3 grid, loose elegant spotlight)
// ----------------------------------------------------------------
export const ZONE_KEYS = [
  'top-left',
  'top-center',
  'top-right',
  'mid-left',
  'center',
  'mid-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type PositionZone = (typeof ZONE_KEYS)[number];

export interface ZoneBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZONE_TO_BBOX: Record<PositionZone, ZoneBbox> = {
  'top-left': { x: 0.05, y: 0.05, w: 0.28, h: 0.28 },
  'top-center': { x: 0.36, y: 0.05, w: 0.28, h: 0.28 },
  'top-right': { x: 0.67, y: 0.05, w: 0.28, h: 0.28 },
  'mid-left': { x: 0.05, y: 0.36, w: 0.28, h: 0.28 },
  center: { x: 0.36, y: 0.36, w: 0.28, h: 0.28 },
  'mid-right': { x: 0.67, y: 0.36, w: 0.28, h: 0.28 },
  'bottom-left': { x: 0.05, y: 0.67, w: 0.28, h: 0.28 },
  'bottom-center': { x: 0.36, y: 0.67, w: 0.28, h: 0.28 },
  'bottom-right': { x: 0.67, y: 0.67, w: 0.28, h: 0.28 },
};

export const DEFAULT_ZONE: PositionZone = 'center';

// Zone-derived regions render as a spotlight box, never the whole-image
// pulse. Confidences are kept >= 0.4 so persistScene's `< 0.4 ⇒ detectionFailed`
// rule never fires on the zone path.
export const ZONE_REGION_CONFIDENCE = 0.85;
export const DEFAULT_REGION_CONFIDENCE = 0.5;

/** Clamp a number to [0,1]; NaN/Infinity collapse to 0. */
export const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
};

/** Return a fresh copy of the §5 bbox for a zone. */
export const zoneToBbox = (zone: PositionZone): ZoneBbox => {
  const b = ZONE_TO_BBOX[zone];
  return { x: b.x, y: b.y, w: b.w, h: b.h };
};

const normalizeTextKey = (s: string): string =>
  s
    .replace(/([a-z])([A-Z])/g, '$1-$2') // bottomRight → bottom-Right
    .toLowerCase()
    .replace(/[_\s.]+/g, '-') // top_left / "top left" → top-left
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Coerce arbitrary input into a canonical zone key, or null if unknown. */
export const normalizeZone = (raw: unknown): PositionZone | null => {
  if (typeof raw !== 'string') return null;
  const key = normalizeTextKey(raw);
  return (ZONE_KEYS as readonly string[]).includes(key) ? (key as PositionZone) : null;
};

// ----------------------------------------------------------------
// Scene-director design types + parsing (§4)
// ----------------------------------------------------------------
export interface SceneDesignElement {
  word: string;
  element?: string;
  presentation?: string;
  positionZone?: PositionZone; // undefined when the director omitted/invalid zone
}

export interface SceneDesign {
  sceneTitle?: string;
  sceneConcept?: string;
  structuredPrompt: string;
  elements: SceneDesignElement[];
}

export interface SceneWordInput {
  text: string;
  pos?: string;
  definitionCn?: string;
}

const normalizeWordKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Extract the first balanced JSON object substring from arbitrary text. */
const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * Parse + validate the scene director's raw text output into a SceneDesign.
 * Returns null on any malformed/insufficient payload so the caller can fall
 * back to the deterministic buildFusionPrompt template (§3.3).
 */
export const parseSceneDesign = (raw: unknown, words: SceneWordInput[]): SceneDesign | null => {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.length === 0) return null;

  // Strip a single surrounding ``` … ``` fence (with or without a language tag).
  const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const slice = extractJsonObject(text);
    if (!slice) return null;
    try {
      parsed = JSON.parse(slice);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const structuredPrompt = typeof parsed.structuredPrompt === 'string' ? parsed.structuredPrompt.trim() : '';
  if (structuredPrompt.length === 0) return null;
  if (!Array.isArray(parsed.elements)) return null;

  const validWordKeys = new Set(words.map((w) => normalizeWordKey(w.text)));

  const elements: SceneDesignElement[] = [];
  for (const rawEl of parsed.elements) {
    if (!rawEl || typeof rawEl !== 'object') continue;
    const wordRaw = typeof rawEl.word === 'string' ? rawEl.word.trim() : '';
    if (wordRaw.length === 0) continue;
    const key = normalizeWordKey(wordRaw);
    if (!validWordKeys.has(key)) continue; // drop hallucinated / off-list words

    // Map back to the canonical input word text so downstream matching is exact.
    const canonical = words.find((w) => normalizeWordKey(w.text) === key)!.text;
    const zone = normalizeZone(rawEl.positionZone);
    const el: SceneDesignElement = { word: canonical };
    if (typeof rawEl.element === 'string' && rawEl.element.trim()) el.element = rawEl.element.trim();
    if (typeof rawEl.presentation === 'string' && rawEl.presentation.trim()) el.presentation = rawEl.presentation.trim();
    if (zone) el.positionZone = zone;
    elements.push(el);
  }

  const design: SceneDesign = { structuredPrompt, elements };
  if (typeof parsed.sceneTitle === 'string' && parsed.sceneTitle.trim()) design.sceneTitle = parsed.sceneTitle.trim();
  if (typeof parsed.sceneConcept === 'string' && parsed.sceneConcept.trim()) design.sceneConcept = parsed.sceneConcept.trim();
  return design;
};

// ----------------------------------------------------------------
// Zone-derived regions (DEFAULT region source — no extra model, §5)
// ----------------------------------------------------------------
export type RegionSource = 'zone' | 'default';

export interface DerivedRegion {
  word: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  source: RegionSource;
}

/**
 * Derive one region per input word from the director's design.
 *  - word with a valid zone element → that zone's bbox, source 'zone'
 *  - otherwise → center bbox, source 'default'
 * Always returns exactly words.length regions in input order.
 */
export const deriveRegionsFromElements = (design: SceneDesign, words: SceneWordInput[]): DerivedRegion[] => {
  const byKey = new Map<string, SceneDesignElement>();
  for (const el of design.elements ?? []) {
    const key = normalizeWordKey(el.word);
    if (!byKey.has(key)) byKey.set(key, el); // first occurrence wins
  }

  return words.map((w) => {
    const el = byKey.get(normalizeWordKey(w.text));
    if (el && el.positionZone) {
      const b = zoneToBbox(el.positionZone);
      return { word: w.text, x: b.x, y: b.y, w: b.w, h: b.h, confidence: ZONE_REGION_CONFIDENCE, source: 'zone' as const };
    }
    const c = zoneToBbox(DEFAULT_ZONE);
    return { word: w.text, x: c.x, y: c.y, w: c.w, h: c.h, confidence: DEFAULT_REGION_CONFIDENCE, source: 'default' as const };
  });
};

// ----------------------------------------------------------------
// Scene-director prompt builders (§4.1 / §4.2)
// ----------------------------------------------------------------
export const buildSceneDirectorSystemPrompt = (): string => {
  const zoneList = ZONE_KEYS.join(', ');
  return [
    'You are an art director for isometric-perspective cartoon illustration.',
    'You are given N English words (each with part-of-speech and a Chinese gloss) and one day-of-week mascot.',
    'Your job:',
    '1. Conceive a single coherent, appealing scene that naturally contains ALL N words AND the mascot (give a scene title and a one-sentence concept).',
    '2. For EACH word decide how to render it visually (noun → object/character; adjective → a character whose expression/body/costume shows it; verb → a character mid-action; adverb → a character behaving that way) and assign it a positionZone.',
    `3. Turn all of that into ONE clear, complete, ready-to-send text-to-image prompt (structuredPrompt): isometric-perspective cartoon style, HD, highly detailed, vibrant saturated colors, 1:1 square composition, the mascot as a visible character, and EVERY element drawn inside its assigned zone. Do NOT add floating captions, subtitles, UI labels, or watermarks (diegetic text on book covers / signs / packaging is allowed).`,
    '',
    `positionZone is CRITICAL — it is BOTH the image-composition instruction AND the region the game will highlight for that word. Choose ONLY from these 9: ${zoneList}.`,
    '- Spread elements across DIFFERENT zones for a balanced, beautiful composition (this matters more than pixel-precise fit).',
    '- N=5–8: one distinct zone per word. N=9–10: a couple of zones may hold two small elements (state front/back occlusion in the presentation); prefer placing the mascot at center.',
    '- Visual elegance beats pixel precision: frame loosely and gracefully rather than crowding to hug an outline.',
    '',
    'Output STRICT JSON ONLY with this shape:',
    '{"sceneTitle":string,"sceneConcept":string,"structuredPrompt":string,"elements":[{"word":string,"element":string,"presentation":string,"positionZone":string}]}.',
    'The elements array MUST contain exactly one entry per input word; word must match the input word text exactly.',
  ].join('\n');
};

export interface SceneDirectorUserPayload {
  words: { text: string; pos: string; definitionCn: string }[];
  dayIndex: number;
  monsterProse: string;
}

export const buildSceneDirectorUserPayload = (
  words: SceneWordInput[],
  dayIndex: number,
  monsterProse: string,
): SceneDirectorUserPayload => ({
  dayIndex,
  monsterProse: String(monsterProse || ''),
  words: words.map((w) => ({
    text: String(w.text || '').trim(),
    pos: String(w.pos || 'noun').trim().toLowerCase(),
    definitionCn: String(w.definitionCn || '').trim(),
  })),
});
