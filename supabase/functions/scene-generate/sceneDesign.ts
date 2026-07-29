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
  /** Natural English description sentence containing `word` verbatim. */
  sentence?: string;
  /**
   * Other target word(s) that SHARE this element's sentence (a two-blank cloze).
   * Capped at 1 by the parser → max 2 target words per sentence. Set only when a
   * duplicate sentence genuinely contains both words, so they're rendered as ONE
   * row with two blanks instead of two answer-leaking single-blank rows.
   */
  pairWords?: string[];
}

/**
 * Structured diagnostics from parsing the scene director's raw LLM output.
 *
 * Surfaces per-run compliance so we can debug LLM regressions without
 * grepping server logs. Emitted on the `designed` and `done` NDJSON events
 * AND on the edge function console.
 */
export interface SceneDesignDiagnostics {
  /** True iff the JSON parsed and contained a valid structuredPrompt + elements array. */
  parsedSuccessfully: boolean;
  /** When parsedSuccessfully=false, a short machine-readable reason. */
  failReason?: 'empty-input' | 'shape-mismatch' | 'no-structured-prompt' | 'elements-not-array' | 'unparseable-json' | 'storyboard-invalid';
  /** Whether the LLM supplied a non-empty `storyboard` field. */
  storyboardPresent: boolean;
  /** Character length of the LLM's storyboard (0 when absent). */
  storyboardLength: number;
  /** Number of sentences the parser split the storyboard into (0 when absent/invalid). */
  storyboardSentenceCount: number;
  /** Number of input words that appear verbatim (case-insensitive) in the storyboard. */
  storyboardWordCoverage: number;
  /**
   * First hard-constraint violation found in the storyboard, or null when the
   * storyboard is present and valid. Parser checks violations in a fixed
   * order; only the first one is reported.
   */
  storyboardViolation:
    | 'too-few-sentences'
    | 'too-many-sentences'
    | 'sentence-without-words'
    | 'sentence-with-too-many-words'
    | 'uncovered-word'
    | null;
  /** Length of the raw LLM text after trimming. */
  rawContentLength: number;
  /** First ~200 chars of the raw LLM text, for human triage. */
  rawContentHead: string;
  /** True iff a <think>...</think> block was stripped before parsing. */
  thinkBlockStripped: boolean;
  /** True iff a ```...``` fence was stripped before parsing. */
  fenceBlockStripped: boolean;
  /** True iff the JSON was extracted from surrounding prose (slow path). */
  jsonExtractedFromProse: boolean;
  /** Number of elements in the parsed design (0 when parse failed). */
  totalElements: number;
  /** Number of input words supplied. */
  inputWordCount: number;
  /** Number of elements with a valid positionZone assigned. */
  zonesAssigned: number;
  /** Number of elements with a valid sentence attached. */
  validSentences: number;
  /** Number of elements whose sentence field was dropped (invalid). */
  droppedSentences: number;
  /** Breakdown of why sentences were dropped. */
  dropReasons: {
    notString: number;
    tooShort: number;
    tooLong: number;
    missingWord: number;
    lazyTemplate: number;
    meansOpener: number;
    /** Target word appears more than once → answer would leak on the sentence. */
    wordRepeated: number;
    /** Sentence is (near-)identical to another element's sentence → clues leak
     *  each other's answer. */
    duplicateSentence: number;
  };
  /** Element words (canonical form) that ended up without a sentence. */
  missingSentenceFields: string[];
  /** Detection of the [TODAYS_MASCOT] placeholder in the structuredPrompt. */
  mascotPlaceholder: {
    used: boolean;
    count: number;
    /** True iff the caller (edge function) replaced the placeholder with a text fallback. */
    replacedInStructuredPrompt: boolean;
  };
}

const MASCOT_PLACEHOLDER_TOKEN = '[TODAYS_MASCOT]';

/** Count occurrences of the mascot placeholder token in a prompt string. */
export const countMascotPlaceholder = (s: string): number => {
  if (typeof s !== 'string' || s.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = s.indexOf(MASCOT_PLACEHOLDER_TOKEN, idx)) !== -1) {
    count += 1;
    idx += MASCOT_PLACEHOLDER_TOKEN.length;
  }
  return count;
};

/**
 * Replace every `[TODAYS_MASCOT]` occurrence in `prompt` with `replacement`.
 * Returns the count of replacements alongside the new string so callers can
 * report diagnostics without rescanning.
 */
export const replaceMascotPlaceholder = (
  prompt: string,
  replacement: string,
): { prompt: string; replacedCount: number } => {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { prompt, replacedCount: 0 };
  }
  if (!prompt.includes(MASCOT_PLACEHOLDER_TOKEN)) {
    return { prompt, replacedCount: 0 };
  }
  const parts = prompt.split(MASCOT_PLACEHOLDER_TOKEN);
  const replacedCount = parts.length - 1;
  return { prompt: parts.join(replacement), replacedCount };
};

export const MASCOT_PLACEHOLDER = MASCOT_PLACEHOLDER_TOKEN;

export interface SceneDesign {
  sceneTitle?: string;
  sceneConcept?: string;
  /** Storyboard: ⌈N/2⌉–N natural-language sentences where each sentence contains
   *  1–2 of the input target words and all N target words appear across the storyboard.
   *  Cloze `sentence` fields in `elements` are derived from these sentences. */
  storyboard?: string;
  structuredPrompt: string;
  elements: SceneDesignElement[];
}

export interface SceneWordInput {
  text: string;
  pos?: string;
  definitionCn?: string;
}

const normalizeWordKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Strip reasoning model chain-of-thought blocks.
 *
 * MiniMax M3, DeepSeek R1, Qwen-QwQ and similar "reasoning" models emit a
 * `<think>...</think>` block containing their internal reasoning BEFORE the
 * actual answer. This block can contain JSON-like braces, prose, and
 * half-formed structures that confuse JSON parsers. We strip it entirely so
 * only the real answer remains.
 *
 * Also handles unclosed `<think>` (model forgot the `</think>` tag) by
 * stripping from `<think>` up to the next standalone `{` on a new line
 * (where the JSON answer typically begins).
 */
export const stripReasoningBlocks = (text: string): string => {
  // Remove closed <think>...</think> blocks.
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  // Handle unclosed <think> (no matching </think> tag).
  // MiniMax M3 sometimes emits <think> reasoning, then starts the JSON
  // WITHOUT a closing </think> tag. We strip everything from <think> up to
  // the first standalone { that begins a line (the JSON object start).
  if (/<think>/i.test(result) && !/<\/think>/i.test(result)) {
    result = result.replace(/<think>[\s\S]*?(?=\n\s*\{)/gi, '');
  }
  // Some models emit <think> on its own line, then JSON on subsequent lines
  // without any closing tag. If <think> still remains, strip the entire
  // <think> tag and everything up to the LAST { (the real JSON usually
  // starts with the outermost object).
  if (/<think>/i.test(result)) {
    const lastBrace = result.lastIndexOf('{');
    if (lastBrace >= 0) {
      // Find the matching opening line
      const lineStart = result.lastIndexOf('\n', lastBrace);
      result = result.slice(lineStart >= 0 ? lineStart + 1 : lastBrace);
    }
  }
  return result;
};

/**
 * Extract ALL balanced {...} substrings from text, in order of appearance.
 * Used to find JSON candidates embedded in prose, reasoning blocks, etc.
 * Each candidate is verified to have balanced braces (string-aware).
 */
const extractAllJsonObjects = (text: string): string[] => {
  const results: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('{', pos);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
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
        if (depth === 0) { end = i; break; }
      }
    }
    if (end >= 0) {
      results.push(text.slice(start, end + 1));
      pos = end + 1;
    } else {
      break; // unbalanced from here — no point continuing
    }
  }
  return results;
};

/**
 * Try to parse text as JSON. If direct parse fails, extract all {...} blocks
 * and return the first one that parses to an object with the expected shape.
 *
 * `shapeProbe` is a function that gets the parsed candidate and returns true
 * if it "looks right" (e.g., has structuredPrompt or elements). This lets us
 * skip JSON-like debris from reasoning blocks and pick the real answer.
 */
const parseJsonLenient = (text: string, shapeProbe: (obj: any) => boolean): any | null => {
  // Fast path: clean JSON.
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && shapeProbe(obj)) return obj;
  } catch { /* not clean JSON — fall through */ }

  // Slow path: extract all {...} candidates and try each.
  const candidates = extractAllJsonObjects(text);
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && shapeProbe(obj)) return obj;
    } catch { /* try next candidate */ }
  }
  return null;
};

// ----------------------------------------------------------------
// Cloze-sentence validation (§4 element.sentence)
// ----------------------------------------------------------------
const SENTENCE_MIN_LENGTH = 5;
const SENTENCE_MAX_LENGTH = 300;

/** Lazily-built regex to detect "The word is X" / "X means ..." lazy templates. */
const LAZY_TEMPLATE_RE = /^the\s+word\s+is\b/i;

export type SentenceInvalidReason =
  | 'notString'
  | 'tooShort'
  | 'tooLong'
  | 'missingWord'
  | 'lazyTemplate'
  | 'meansOpener'
  | 'wordRepeated';

/**
 * Validate a cloze sentence for a target word.
 *
 * Rules:
 *   - Length within [SENTENCE_MIN_LENGTH, SENTENCE_MAX_LENGTH]
 *   - Contains `word` as a verbatim word-boundary match (case-insensitive)
 *   - Reject templated openers: "The word is X", "X means ...", "Means X"
 *
 * Returns true iff the sentence is acceptable.
 */
export const isValidSentence = (sentence: unknown, word: string): boolean => {
  return validateSentence(sentence, word) === null;
};

/**
 * Validate a cloze sentence and return the first failing reason (or null when valid).
 * Exposed so parsers can bucket diagnostic counters without re-running checks.
 */
export const validateSentence = (
  sentence: unknown,
  word: string,
): SentenceInvalidReason | null => {
  if (typeof sentence !== 'string') return 'notString';
  const s = sentence.trim();
  if (s.length < SENTENCE_MIN_LENGTH) return 'tooShort';
  if (s.length > SENTENCE_MAX_LENGTH) return 'tooLong';
  const target = String(word || '').trim().toLowerCase();
  if (!target) return 'missingWord';
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Count word-boundary occurrences of the target. The target must appear
  // EXACTLY ONCE — at the cloze blank. If it shows up elsewhere in the same
  // sentence, the answer is literally written on the clue, so reject. (This
  // is a stricter check than the old "exists at least once" `re.test`.)
  const wordRe = new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, 'gi');
  const occurrences = (s.match(wordRe) || []).length;
  if (occurrences === 0) return 'missingWord';
  if (occurrences > 1) return 'wordRepeated';
  if (LAZY_TEMPLATE_RE.test(s)) return 'lazyTemplate';
  const meansOpener = new RegExp(`^${escaped}\\s+means\\b`, 'i');
  if (meansOpener.test(s)) return 'meansOpener';
  if (/^means\b/i.test(s)) return 'meansOpener';
  return null;
};

/**
 * Scrub the [TODAYS_MASCOT] / [TODAY_MOSCOT] placeholder AND the standalone
 * word "mascot" (which is too academic for language learners) from a cloze
 * sentence or storyboard. The placeholder is an image-prompt-only token; the
 * word "mascot" is rejected because the product owner wants learners to see
 * the everyday English word "monster" instead.
 *
 * Replace with `replacement` (default: "monster"). Trims double spaces.
 */
export const scrubMascotPlaceholder = (
  text: string,
  replacement: string = 'monster',
): string => {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  // 1) The placeholder token, with common typos (MOSCOT vs MASCOT) and
  //    optional surrounding whitespace.
  out = out.replace(/\s*\[\s*(?:TODAYS?_MASCOT|TODAY_MOSCOT|TODAYS_MOSCOT)\s*\]\s*/gi, ` ${replacement} `);
  // 2) The standalone word "mascot" / "mascots" as a whole word (case-
  //    insensitive). The adjective form is preserved when prefix-matched
  //    ("mascot-shaped" → "monster-shaped") by replacing the head noun.
  out = out.replace(/\bmascots?\b/gi, replacement);
  return out.replace(/\s{2,}/g, ' ').trim();
};

// ----------------------------------------------------------------
// Storyboard parsing & word-to-sentence mapping (§4 storyboard-first refactor)
// ----------------------------------------------------------------

/**
 * Split a storyboard string into sentences using a punctuation heuristic.
 * Simplified: splits on `[.!?]+\s+` and strips trailing `.!?` whitespace so
 * downstream comparisons (e.g. mapWordToStoryboardSentence) return clean
 * sentences without dangling periods.
 * Returns at least one entry when input is non-empty; returns [] for empty input.
 */
export const splitStoryboardSentences = (storyboard: string): string[] => {
  if (typeof storyboard !== 'string' || storyboard.trim().length === 0) return [];
  return storyboard
    .split(/[.!?]+\s+/)
    .map((s) => s.trim().replace(/[.!?]+$/, '').trim())
    .filter((s) => s.length > 0);
};

export interface StoryboardParseResult {
  /** The (trimmed) sentences after splitting. */
  sentences: string[];
  /** How many input words appear verbatim in the storyboard (case-insensitive). */
  wordCoverage: number;
  /** First hard-constraint violation, or null when valid. */
  violation: SceneDesignDiagnostics['storyboardViolation'];
}

/**
 * Validate that a storyboard meets the §4 hard constraints:
 *   - sentenceCount is in [ceil(N/2), N]
 *   - every sentence contains 1..2 of the target words (case-insensitive)
 *   - all N target words appear at least once across the storyboard
 *
 * Returns the first violation found (parser checks in a fixed order). When the
 * storyboard is invalid the caller should reject the LLM response and fall
 * back to buildFusionResult. The function never throws — bad inputs yield
 * `violation` values rather than exceptions.
 */
export const parseStoryboard = (
  storyboard: unknown,
  words: SceneWordInput[],
): StoryboardParseResult => {
  const empty: StoryboardParseResult = {
    sentences: [],
    wordCoverage: 0,
    violation: 'too-few-sentences',
  };
  if (typeof storyboard !== 'string') return empty;
  const trimmed = storyboard.trim();
  if (trimmed.length === 0) return empty;

  const wordList = Array.isArray(words) ? words : [];
  const N = wordList.length;
  if (N === 0) {
    return { sentences: [], wordCoverage: 0, violation: 'too-few-sentences' };
  }
  const minSentences = Math.max(1, Math.ceil(N / 2));

  const sentences = splitStoryboardSentences(trimmed);
  if (sentences.length < minSentences) {
    return { sentences, wordCoverage: 0, violation: 'too-few-sentences' };
  }
  if (sentences.length > N) {
    return { sentences, wordCoverage: 0, violation: 'too-many-sentences' };
  }

  // Pre-compute lowercase word keys once.
  const wordKeys: string[] = wordList.map((w) => normalizeWordKey(w.text));
  const wordSet = new Set(wordKeys);

  // Validate each sentence contains 1..2 distinct target words.
  for (const sentence of sentences) {
    const seen = countStoryboardWordsInSentence(sentence, wordKeys, wordSet);
    if (seen < 1) {
      return { sentences, wordCoverage: 0, violation: 'sentence-without-words' };
    }
    if (seen > 2) {
      return { sentences, wordCoverage: 0, violation: 'sentence-with-too-many-words' };
    }
  }

  // Coverage: how many distinct words appear at least once across the whole storyboard.
  const combined = sentences.join(' ');
  let covered = 0;
  for (const key of wordKeys) {
    if (containsWordVerbatim(combined, key)) covered += 1;
  }
  if (covered < N) {
    return { sentences, wordCoverage: covered, violation: 'uncovered-word' };
  }

  return { sentences, wordCoverage: covered, violation: null };
};

/**
 * Count how many distinct target words appear (verbatim, case-insensitive) in `sentence`.
 * Each word contributes at most 1 — duplicates of the same word do not push the count above 1.
 */
const countStoryboardWordsInSentence = (
  sentence: string,
  wordKeys: string[],
  wordSet: Set<string>,
): number => {
  let count = 0;
  for (const key of wordKeys) {
    if (containsWordVerbatim(sentence, key)) count += 1;
  }
  // Suppress unused-param warning while keeping API extensible (wordSet unused
  // here but reserved for future fast-path).
  void wordSet;
  return count;
};

/**
 * Verbatim, case-insensitive word-boundary match. Reuses the regex pattern
 * from validateSentence for consistency.
 */
const containsWordVerbatim = (haystack: string, wordKey: string): boolean => {
  if (!wordKey) return false;
  const escaped = wordKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, 'i');
  return re.test(haystack);
};

/**
 * Find the storyboard sentence that contains `word` verbatim. Returns null
 * when no sentence contains it or when multiple sentences contain it
 * (the second case is rare and signals an LLM formatting issue — caller
 * should fall back rather than guess).
 */
export const mapWordToStoryboardSentence = (
  storyboard: string | undefined | null,
  word: string,
): string | null => {
  if (typeof storyboard !== 'string' || storyboard.trim().length === 0) return null;
  const key = normalizeWordKey(word);
  if (!key) return null;
  const sentences = splitStoryboardSentences(storyboard);
  let found: string | null = null;
  for (const sentence of sentences) {
    if (containsWordVerbatim(sentence, key)) {
      if (found !== null) return null; // multiple matches → ambiguous
      found = sentence;
    }
  }
  return found;
};

/**
 * Parse + validate the scene director's raw text output into a SceneDesign.
 * Returns null on any malformed/insufficient payload so the caller can fall
 * back to the deterministic buildFusionPrompt template (§3.3).
 *
 * Handles:
 *   - Clean JSON
 *   - JSON wrapped in ```json fences
 *   - JSON preceded by reasoning-model <think> blocks (MiniMax, DeepSeek, etc.)
 *   - JSON embedded in prose
 *   - Multiple JSON candidates (picks the one with structuredPrompt/elements)
 *
 * Thin wrapper around `parseSceneDesignWithDiagnostics` for callers that
 * don't need the diagnostic report.
 */
export const parseSceneDesign = (raw: unknown, words: SceneWordInput[]): SceneDesign | null => {
  return parseSceneDesignWithDiagnostics(raw, words).design;
};

const emptyDropReasons = (): SceneDesignDiagnostics['dropReasons'] => ({
  notString: 0,
  tooShort: 0,
  tooLong: 0,
  missingWord: 0,
  lazyTemplate: 0,
  meansOpener: 0,
  wordRepeated: 0,
  duplicateSentence: 0,
});

const reasonKey: Record<SentenceInvalidReason, keyof SceneDesignDiagnostics['dropReasons']> = {
  notString: 'notString',
  tooShort: 'tooShort',
  tooLong: 'tooLong',
  missingWord: 'missingWord',
  lazyTemplate: 'lazyTemplate',
  meansOpener: 'meansOpener',
  wordRepeated: 'wordRepeated',
};

// Normalize a sentence for duplicate detection: case-insensitive, strip all
// punctuation, collapse whitespace. "A ball sits on the ground." and
// "a ball sits on the ground" collide → treated as the same clue.
const signatureOf = (sentence: string): string =>
  sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Count word-boundary occurrences of `word` in `sentence` (case-insensitive).
// Mirrors the matcher in validateSentence so "appears exactly once" checks stay
// consistent with what the validator permits.
const countWordOccurrences = (sentence: string, word: string): number => {
  const target = String(word || '').trim().toLowerCase();
  if (!target) return 0;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, 'gi');
  return (String(sentence || '').match(re) || []).length;
};

// ----------------------------------------------------------------
// Last-resort deterministic backfill — GUARANTEES no "picture-only".
//
// After the director LLM has had its chances (initial call + retries), any
// element still missing a valid cloze sentence gets a simple, grammatical,
// mutually-distinct sentence generated from these templates. Templates are
// POS-aware: a noun gets "Look at the {word}.", an ADJECTIVE like "red" gets
// "Something in the picture is red." (NOT "Look at the red.", which is
// ungrammatical), a verb gets "You can see someone {word}.".
//
// These are intentionally basic A1 clues — quality is the LLM's job; this just
// closes the door on "picture-only" so a learner always has a text clue. For a
// color/adjective the clue "something is red" is actually a good hint: it tells
// the learner to look for the red thing in the scene.
// ----------------------------------------------------------------
const BACKFILL_TEMPLATES: { adjective: ((w: string) => string)[]; verb: ((w: string) => string)[]; noun: ((w: string) => string)[] } = {
  adjective: [
    (w) => `Something in the picture is ${w}.`,
    (w) => `One thing here looks ${w}.`,
    (w) => `A ${w} thing is easy to see.`,
    (w) => `Can you find the ${w} object?`,
  ],
  verb: [
    (w) => `You can see someone ${w} in the picture.`,
    (w) => `Someone will ${w} very soon here.`,
    (w) => `Look, they ${w} in the scene.`,
  ],
  noun: [
    (w) => `Look at the ${w} in the picture.`,
    (w) => `Can you see the ${w} here?`,
    (w) => `Point to the ${w} in the scene.`,
    (w) => `Find the ${w} in this picture.`,
    (w) => `The ${w} is easy to spot.`,
  ],
};

const backfillTemplateGroup = (pos: string): ((w: string) => string)[] => {
  const p = (pos || '').trim().toLowerCase();
  if (p.startsWith('adj')) return BACKFILL_TEMPLATES.adjective;
  if (p.startsWith('v') || p === 'verb') return BACKFILL_TEMPLATES.verb;
  return BACKFILL_TEMPLATES.noun; // noun, adverb, unknown → noun-style (most common)
};

/**
 * Fill in a valid, distinct cloze sentence for every design element still
 * missing one. Mutates `design.elements` in place. Returns the count filled.
 * Call this ONLY after the LLM retry loop has run, so the LLM gets every
 * chance to produce quality sentences first.
 */
export const backfillMissingSentences = (
  design: SceneDesign | null,
  words: SceneWordInput[] = [],
): number => {
  if (!design || !Array.isArray(design.elements)) return 0;
  const posByWord = new Map<string, string>();
  for (const w of words) {
    if (w && typeof w.text === 'string') posByWord.set(normalizeWordKey(w.text), (w as any).pos || '');
  }
  // Collect signatures of already-accepted sentences so backfilled ones stay
  // mutually distinct AND don't collide with the LLM's good sentences.
  const seen = new Set<string>();
  for (const el of design.elements) {
    if (typeof el.sentence === 'string' && el.sentence.trim()) seen.add(signatureOf(el.sentence));
  }
  let filled = 0;
  for (const el of design.elements) {
    if (typeof el.sentence === 'string' && el.sentence.trim()) continue; // already has one
    if (typeof el.word !== 'string' || !el.word.trim()) continue;
    const word = el.word.trim();
    const group = backfillTemplateGroup(posByWord.get(normalizeWordKey(word)) || '');
    for (const make of group) {
      const cand = make(word);
      if (validateSentence(cand, word) !== null) continue; // failed length / word-count / template rules
      const sig = signatureOf(cand);
      if (seen.has(sig)) continue; // would duplicate another clue
      el.sentence = cand;
      seen.add(sig);
      filled += 1;
      break;
    }
  }
  return filled;
};

/**
 * Build the client-facing cloze groups from a parsed design. Each element with a
 * sentence becomes ONE group: `[el.word, ...el.pairWords]` + its sentence. A
 * paired element (pairWords set) yields a 2-word group → one row, two blanks.
 * Elements without a sentence are skipped (the client treats those words as
 * picture-only via the per-word `sentences` index). Order follows `elements`.
 */
export interface ClozeGroup {
  words: string[];
  sentence: string;
}
export const buildClozeGroups = (design: SceneDesign | null): ClozeGroup[] => {
  if (!design || !Array.isArray(design.elements)) return [];
  const groups: ClozeGroup[] = [];
  for (const el of design.elements) {
    if (typeof el.sentence !== 'string' || !el.sentence.trim()) continue;
    if (typeof el.word !== 'string' || !el.word.trim()) continue;
    groups.push({ words: [el.word.trim(), ...(el.pairWords || []).map((p) => p.trim())], sentence: el.sentence.trim() });
  }
  return groups;
};

const failDiagnostics = (
  reason: SceneDesignDiagnostics['failReason'],
  rawText: string,
  flags: { think: boolean; fence: boolean; prose: boolean },
  inputWordCount: number,
  storyboardStats: {
    present: boolean;
    length: number;
    sentenceCount: number;
    wordCoverage: number;
    violation: SceneDesignDiagnostics['storyboardViolation'];
  } = { present: false, length: 0, sentenceCount: 0, wordCoverage: 0, violation: null },
): { design: null; diagnostics: SceneDesignDiagnostics } => ({
  design: null,
  diagnostics: {
    parsedSuccessfully: false,
    failReason: reason,
    storyboardPresent: storyboardStats.present,
    storyboardLength: storyboardStats.length,
    storyboardSentenceCount: storyboardStats.sentenceCount,
    storyboardWordCoverage: storyboardStats.wordCoverage,
    storyboardViolation: storyboardStats.violation,
    rawContentLength: typeof rawText === 'string' ? rawText.trim().length : 0,
    rawContentHead: typeof rawText === 'string' ? rawText.trim().slice(0, 200) : '',
    thinkBlockStripped: flags.think,
    fenceBlockStripped: flags.fence,
    jsonExtractedFromProse: flags.prose,
    totalElements: 0,
    inputWordCount,
    zonesAssigned: 0,
    validSentences: 0,
    droppedSentences: 0,
    dropReasons: emptyDropReasons(),
    missingSentenceFields: [],
    mascotPlaceholder: { used: false, count: 0, replacedInStructuredPrompt: false },
  },
});

/**
 * Same as parseSceneDesign, but also returns a structured diagnostics report.
 * Use this from the edge function to surface LLM-output quality metrics via
 * console + NDJSON.
 */
export const parseSceneDesignWithDiagnostics = (
  raw: unknown,
  words: SceneWordInput[],
): { design: SceneDesign | null; diagnostics: SceneDesignDiagnostics } => {
  const inputWordCount = Array.isArray(words) ? words.length : 0;

  if (typeof raw !== 'string') {
    return failDiagnostics('empty-input', '', { think: false, fence: false, prose: false }, inputWordCount);
  }
  const originalRaw = raw;
  let text = raw.trim();
  if (text.length === 0) {
    return failDiagnostics('empty-input', originalRaw, { think: false, fence: false, prose: false }, inputWordCount);
  }

  // Strip reasoning-model <think>...</think> blocks first.
  const beforeThink = text;
  text = stripReasoningBlocks(text);
  const thinkStripped = text !== beforeThink;

  // Strip a single surrounding ``` … ``` fence (with or without a language tag).
  const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  let fenceStripped = false;
  if (fence) {
    text = fence[1].trim();
    fenceStripped = true;
  }

  // Try clean JSON first to detect "extracted from prose" precisely.
  let parsed: any = null;
  let jsonFromProse = false;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && (typeof obj.structuredPrompt === 'string' || Array.isArray(obj.elements))) {
      parsed = obj;
    }
  } catch {
    /* fall through to slow path */
  }
  if (!parsed) {
    parsed = parseJsonLenient(text, (obj) =>
      typeof obj.structuredPrompt === 'string' || Array.isArray(obj.elements),
    );
    if (parsed) jsonFromProse = true;
  }

  if (!parsed) {
    return failDiagnostics('unparseable-json', originalRaw, { think: thinkStripped, fence: fenceStripped, prose: jsonFromProse }, inputWordCount);
  }

  const structuredPrompt = typeof parsed.structuredPrompt === 'string' ? parsed.structuredPrompt.trim() : '';
  if (structuredPrompt.length === 0) {
    return failDiagnostics('no-structured-prompt', originalRaw, { think: thinkStripped, fence: fenceStripped, prose: jsonFromProse }, inputWordCount);
  }
  if (!Array.isArray(parsed.elements)) {
    return failDiagnostics('elements-not-array', originalRaw, { think: thinkStripped, fence: fenceStripped, prose: jsonFromProse }, inputWordCount);
  }

  const validWordKeys = new Set(words.map((w) => normalizeWordKey(w.text)));

  const elements: SceneDesignElement[] = [];
  const dropReasons = emptyDropReasons();
  const missingSentenceFields: string[] = [];
  // Signatures of sentences already accepted, to reject duplicates across
  // elements. Two identical clues with different target words reveal each
  // other's answer, so the second (and any later) occurrence is dropped.
  const seenSignatures = new Set<string>();
  let zonesAssigned = 0;
  let validSentences = 0;

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
    if (zone) {
      el.positionZone = zone;
      zonesAssigned += 1;
    }
    // Validate the cloze sentence; if it fails, leave the element sentence-less.
    // We deliberately do NOT backfill a fallback template like "The word X is
    // hidden in today's scene" — that sentence is meaningless to the learner,
    // wastes TTS resources, and clutters the REVIEW screen. Instead, the client
    // shows "Picture only — guess word #N." in PLAYING and just the word itself
    // in REVIEW. Also scrub the [TODAYS_MASCOT] placeholder if the LLM leaked it.
    const scrubbedSentence = typeof rawEl.sentence === 'string'
      ? scrubMascotPlaceholder(rawEl.sentence)
      : rawEl.sentence;
    const sentenceReason = validateSentence(scrubbedSentence, canonical);
    if (sentenceReason === null) {
      const sig = signatureOf(scrubbedSentence as string);
      const acceptedSentenceStr = sig.length > 0 ? (scrubbedSentence as string).trim() : '';
      if (sig.length > 0 && seenSignatures.has(sig)) {
        // Duplicate of an already-accepted clue. Two identical single-blank rows
        // would leak each other's answer. PREFER to MERGE: if this word also
        // appears exactly once in the shared sentence, attach it as a pairWord
        // of the already-accepted element → one row, two blanks, no leak.
        // (Capped at 2 words/sentence.) Otherwise fall back to dropping it.
        const acceptor = elements.find(
          (e) => typeof e.sentence === 'string' && signatureOf(e.sentence!) === sig && (!e.pairWords || e.pairWords.length === 0),
        );
        const canPair =
          !!acceptor &&
          !!acceptedSentenceStr &&
          countWordOccurrences(acceptedSentenceStr, canonical) === 1 &&
          !acceptor.pairWords; // max 2 words per sentence
        if (canPair) {
          acceptor!.pairWords = [...(acceptor!.pairWords || []), canonical];
          // The current element is covered by the pair — do NOT push a separate
          // element, do NOT count a drop. Both words map to the one sentence.
          validSentences += 1;
          continue; // skip elements.push(el) below
        }
        // Not mergeable (other word absent, or acceptor already paired) → drop.
        dropReasons.duplicateSentence += 1;
        missingSentenceFields.push(canonical);
      } else {
        if (sig.length > 0) seenSignatures.add(sig);
        el.sentence = acceptedSentenceStr;
        validSentences += 1;
      }
    } else {
      dropReasons[reasonKey[sentenceReason]] += 1;
      missingSentenceFields.push(canonical);
      // No backfill — element.sentence stays undefined. The client handles
      // the "no sentence" case gracefully (picture-only clue).
    }
    elements.push(el);
  }
  // Defensive sweep: any input word that has NO element at all (LLM dropped it
  // entirely) gets a bare element (word only, no sentence) so the region map
  // still includes it. The client renders these as "Picture only" in PLAYING
  // and shows just the word in REVIEW.
  // A word is "covered" if it is an element's own `word` OR appears in some
  // element's `pairWords` (two-blank pair). Only uncovered words get a bare
  // (picture-only) element so the region map still includes them.
  const isCovered = (k: string) =>
    elements.some(
      (e) => normalizeWordKey(e.word) === k || (e.pairWords || []).some((p) => normalizeWordKey(p) === k),
    );
  for (const w of words) {
    const key = normalizeWordKey(w.text);
    if (!isCovered(key)) {
      elements.push({
        word: w.text,
        // No sentence — client handles gracefully.
      });
      missingSentenceFields.push(w.text);
    }
  }

  const design: SceneDesign = { structuredPrompt, elements };
  if (typeof parsed.sceneTitle === 'string' && parsed.sceneTitle.trim()) design.sceneTitle = parsed.sceneTitle.trim();
  if (typeof parsed.sceneConcept === 'string' && parsed.sceneConcept.trim()) design.sceneConcept = parsed.sceneConcept.trim();

  const placeholderCount = countMascotPlaceholder(structuredPrompt);

  // Storyboard soft-validation. The storyboard is connective prose; if it's
  // malformed (wrong sentence count, missing words, etc.) we DROP the
  // storyboard field but KEEP the rest of the design — the cloze sentences on
  // elements[].sentence are what the UI actually needs, and we already validated
  // each one above. The old behavior (reject the entire design when storyboard
  // was present-but-invalid) was discarding director successes whenever the
  // LLM's prose didn't perfectly match ⌈N/2⌉-N sentence count, forcing the
  // useless "hidden in today's scene" fallback template.
  // Also scrub any [TODAYS_MASCOT] that leaked into the storyboard.
  const storyboardRawRaw = typeof parsed.storyboard === 'string' ? parsed.storyboard : '';
  const storyboardRaw = scrubMascotPlaceholder(storyboardRawRaw);
  const storyboardParsed = parseStoryboard(storyboardRaw, words);
  const storyboardPresent = storyboardRaw.trim().length > 0;
  const storyboardStats = {
    present: storyboardPresent,
    length: storyboardRaw.trim().length,
    sentenceCount: storyboardParsed.sentences.length,
    wordCoverage: storyboardParsed.wordCoverage,
    violation: storyboardParsed.violation,
  };
  if (storyboardPresent && storyboardParsed.violation === null) {
    design.storyboard = storyboardRaw.trim();
  }

  const diagnostics: SceneDesignDiagnostics = {
    parsedSuccessfully: true,
    storyboardPresent,
    storyboardLength: storyboardStats.length,
    storyboardSentenceCount: storyboardStats.sentenceCount,
    storyboardWordCoverage: storyboardStats.wordCoverage,
    storyboardViolation: storyboardStats.violation,
    rawContentLength: originalRaw.trim().length,
    rawContentHead: originalRaw.trim().slice(0, 200),
    thinkBlockStripped: thinkStripped,
    fenceBlockStripped: fenceStripped,
    jsonExtractedFromProse: jsonFromProse,
    totalElements: elements.length,
    inputWordCount,
    zonesAssigned,
    validSentences,
    droppedSentences: missingSentenceFields.length,
    dropReasons,
    missingSentenceFields,
    mascotPlaceholder: {
      used: placeholderCount > 0,
      count: placeholderCount,
      replacedInStructuredPrompt: false, // updated by the caller after substitution
    },
  };

  return { design, diagnostics };
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
  sentence?: string;
}

/**
 * Derive one region per input word from the director's design.
 *  - word with a valid zone element → that zone's bbox, source 'zone'
 *  - otherwise → center bbox, source 'default'
 * Always returns exactly words.length regions in input order.
 * The element's `sentence` (when present) is carried through to the region.
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
      return {
        word: w.text,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        confidence: ZONE_REGION_CONFIDENCE,
        source: 'zone' as const,
        ...(el.sentence ? { sentence: el.sentence } : {}),
      };
    }
    const c = zoneToBbox(DEFAULT_ZONE);
    return {
      word: w.text,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      confidence: DEFAULT_REGION_CONFIDENCE,
      source: 'default' as const,
      ...(el?.sentence ? { sentence: el.sentence } : {}),
    };
  });
};

// ----------------------------------------------------------------
// Scene-director prompt builders (§4.1 / §4.2)
//
// Storyboard-first refactor: the prompt is reorganized into four numbered
// stages so the LLM writes the storyboard BEFORE the per-element metadata,
// image prompt, and cloze sentences. This ordering means the cloze sentences
// (which previously got dropped 100% of the time) become a mechanical
// derivation step the LLM cannot forget.
// ----------------------------------------------------------------
export const buildSceneDirectorSystemPrompt = (): string => {
  const zoneList = ZONE_KEYS.join(', ');
  return [
    'You are an art director AND a vocabulary teacher for an isometric-perspective',
    'cartoon scene game. Language learners will see the scene image you describe AND,',
    'for each target word, ONE fill-in-the-blank sentence you write. The sentence must',
    'help the learner guess the word by describing something VISIBLE in the scene.',
    '',
    '╔═════════════════════════════════════════════════════════════════════╗',
    '║  THREE HARD RULES — every sentence MUST satisfy ALL of them        ║',
    '╚═════════════════════════════════════════════════════════════════════╝',
    ' 1. EXACTLY ONCE — the target word appears ONE time in its sentence (it will be',
    '    blanked). Never twice: a second copy leaks the answer on the clue itself.',
    ' 2. ALL DISTINCT — no two sentences may be the same or near-identical. Two clues',
    '    that read alike but blank different words reveal each other\'s answer. Each',
    '    sentence is built around its OWN word and reads differently from every other.',
    ' 3. REAL CLUE — a short A1–A2 scene description containing the word. Never a',
    '    definition, template, or translation.',
    ' These are verified after generation ONLY as a safety net. You are expected to',
    ' satisfy them on the FIRST try — do not rely on retries. Get it right once.',
    '',
    '═══════════════════════════════════════════════════════════════════',
    'STAGE 1 — CLOZE SENTENCES (your PRIMARY deliverable; write this FIRST)',
    '═══════════════════════════════════════════════════════════════════',
    'For EACH input word, write ONE English sentence that:',
    '  • contains the word verbatim (case-insensitive, but keep spelling exact)',
    '  • contains the target word EXACTLY ONCE. The word will be blanked out to',
    '    make the cloze — if it appears anywhere else in the same sentence the',
    '    answer is leaked on the clue itself. So never repeat the target word',
    '    inside its own sentence (e.g. "The ball rolls past another ball." is',
    '    FORBIDDEN for the word "ball").',
    '  • is 6–12 words long (short, beginner-friendly sentences)',
    '  • uses ONLY common English words from the CEFR A1–A2 list (~1000 most',
    '    frequent English words). The target word itself is exempt — every OTHER',
    '    word in the sentence must be A1/A2 level.',
    '  • Avoid idioms, slang, jargon, abbreviations, and proper nouns (unless the',
    '    proper noun IS the target word).',
    '  • Prefer simple Subject-Verb-Object word order. Avoid passive voice, nested',
    '    clauses, and past-perfect tenses.',
    '  • describes something VISIBLE in the scene (so the learner can use the',
    '    image as a clue, not just the sentence alone)',
    '  • is a real grammatical sentence about the scene — NOT a definition',
    '',
    'GOOD sentences (short, A1–A2 vocabulary, scene description):',
    '  "The boy eats a red apple."                      ← 6 words, A1 vocabulary',
    '  "Two kids run in the rain."                      ← 6 words, A1 vocabulary',
    '  "The angry man hits the table."                  ← 7 words, A1/A2 vocabulary',
    '',
    'BAD sentences (the model MUST NEVER produce these):',
    '  "The youngster gleefully devours a crimson Malus domestica."   ← hard words',
    '  "The word is apple."                                            ← lazy template',
    '  "Apple means a red fruit."                                      ← dictionary definition',
    '  "In this scene there is an apple."                              ← filler template',
    '  "苹果 means apple in English."                                   ← bilingual translation',
    '  "The red apple and the red ball."                               ← target word "red" repeated',
    '',
    'WRITE THE SENTENCE BY PART OF SPEECH (use each word\'s `pos`):',
    '  • NOUN (apple, cow, moon): name ONE visible instance.',
    '      "The cow stands by the wooden fence."',
    '  • ADJECTIVE — especially COLORS (red, big, angry): apply it to ONE visible',
    '    object as "The {noun} is {adj}." or "a {adj} {noun}". Use the adjective ONE',
    '    time; do not describe several objects that share it.',
    '      "red"   → "The apple is red."            (NOT "The red ball by the red box")',
    '      "angry" → "The angry man hits the table."',
    '  • VERB (run, eat, jump): "The boy {verb}s …" or "You can see someone {verb}."',
    '      "run" → "Two kids run across the wet grass."',
    '  • ADVERB (quickly, softly): "Someone {verb}s {adv}."',
    '      "quickly" → "The boy quickly eats his food."',
    '  • DETERMINER / PRONOUN (this, that, these, those): point at visible things.',
    '      "these" → "These boxes are full of old toys."',
    '',
    'TWO WORDS, ONE OBJECT → STILL TWO DIFFERENT SENTENCES:',
    '  If two target words both fit the same visible thing, do NOT give them the same',
    '  sentence. Build a fresh sentence around EACH word so all sentences stay distinct:',
    '    words "cow" + "these" →',
    '      cow   → "The brown cow looks right at us."',
    '      these → "These boxes are full of old toys."',
    '    (WRONG: writing "A cow stands near these boxes." for BOTH — that one sentence',
    '     reused for two words makes the two clues reveal each other\'s answer.)',
    '',
    '═══════════════════════════════════════════════════════════════════',
    'STAGE 2 — STORYBOARD (connective prose; derived from your sentences)',
    '═══════════════════════════════════════════════════════════════════',
    'Concatenate your Stage 1 sentences (or close paraphrases) into ONE storyboard',
    'string of ⌈N/2⌉–N sentences. Every sentence must contain 1–2 of the input',
    'target words verbatim, and every input word must appear at least once across',
    'the storyboard.',
    '',
    'Example storyboard for [house, rain, angry, run, moon, fountain] (N=6 → 3–6 sentences):',
    '  "A small wooden house sits on a misty mountain. An angry monster leans',
    '   at the door, soaked because it has rained for days. Everything is wet,',
    '   dripping from moss-covered trees, while a pale moon rises over a dry',
    '   fountain nearby."',
    '',
    '═══════════════════════════════════════════════════════════════════',
    'STAGE 3 — IMAGE PROMPT (translated from the storyboard for the image model)',
    '═══════════════════════════════════════════════════════════════════',
    'Write ONE text-to-image prompt (structuredPrompt) that re-tells the same scene',
    'for the image model. Style: isometric-perspective cartoon, HD, vibrant saturated',
    'colors, 1:1 square. The image MUST depict what your Stage 1 sentences describe',
    'so the learner can match each sentence to something visible.',
    '',
    'For the mascot, insert the literal token [TODAYS_MASCOT] EXACTLY ONE time where',
    'the mascot appears. This token is ONLY for the image model — we will inject the',
    'canonical reference image at that position. NEVER use [TODAYS_MASCOT] in the',
    'storyboard or in elements[].sentence — those are shown to learners and must',
    'use plain English. When you refer to the mascot in those learner-facing strings,',
    'you MUST use the single word "monster" (e.g. "the little monster", "a friendly',
    'monster"). NEVER use the word "mascot", "creature", "beast", "animal", or any',
    'other synonym — those are too obscure or academic for language learners. Always',
    '"monster".',
    'Do NOT describe the monster\'s colors or shape in structuredPrompt — we will',
    'inject the canonical reference image.',
    '',
    '═══════════════════════════════════════════════════════════════════',
    'STAGE 4 — METADATA',
    '═══════════════════════════════════════════════════════════════════',
    ' • sceneTitle: short evocative title for the scene (≤ 8 words).',
    ' • sceneConcept: one sentence that summarizes the scene\'s mood/action.',
    '',
    '═══════════════════════════════════════════════════════════════════',
    'OUTPUT — ONE JSON object (no markdown fences, no prose before/after)',
    '═══════════════════════════════════════════════════════════════════',
    '{',
    '  "storyboard": string,            // ⌈N/2⌉–N sentences from STAGE 2',
    '  "sceneTitle": string,',
    '  "sceneConcept": string,',
    '  "structuredPrompt": string,      // contains EXACTLY ONE [TODAYS_MASCOT] token',
    '  "elements": [',
    '    {',
    '      "word": string,              // MUST match input word text exactly',
    '      "sentence": string,          // REQUIRED — the STAGE 1 sentence for this word',
    '      "element": string,           // short visual description of this element',
    '      "presentation": string,      // style/lighting/perspective hint',
    `      "positionZone": string,      // ONE of: ${zoneList}`,
    '    }',
    '    // …exactly N entries, one per input word, in any order',
    '  ]',
    '}',
    '',
    'CRITICAL RULES (read carefully):',
    ' • The `sentence` field is REQUIRED on every element. If you omit it, the',
    '   learner sees no clue and the round is broken. structuredPrompt is downstream',
    '   from the sentences — write sentences first, then derive the prompt.',
    ' • Every elements[].sentence MUST be mutually distinct. NEVER reuse the same',
    '   sentence (or a near-identical one) for two different words — two clues that',
    '   read the same but blank different words reveal each other\'s answer. Each',
    '   sentence must be built around its OWN target word and read differently.',
    ' • Each target word appears EXACTLY ONCE in its own sentence (see STAGE 1).',
    ' • DO NOT add floating captions, subtitles, UI labels, or watermarks to the image.',
    ' • DO NOT describe the mascot\'s colors, shape, or features inside structuredPrompt.',
    '',
    'ANATOMY CONSTRAINTS (image models easily produce mutants — enforce these):',
    ' • Every animal (dog, cat, horse, dinosaur, etc.) MUST have the species-correct',
    '   number of body parts: exactly 2 eyes, 2 ears, the correct limb count for the',
    '   species (4 for quadrupeds, 2 for birds, etc.), 1 nose, 1 mouth.',
    ' • NO extra limbs, NO duplicated facial features, NO mutated anatomy, NO fingers',
    '   growing from wrong joints. If unsure, err toward fewer features, not more.',
    ' • The mascot is the only fantasy creature allowed, and even it must have exactly',
    '   2 eyes, 2 arms, 2 legs, 1 mouth — symmetrical and anatomically believable.',
    ' • When describing an animal in structuredPrompt, prefer a clear single pose',
    '   (side profile or 3/4 view) over complex multi-angle compositions — single',
    '   poses produce far fewer anatomy errors.',
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

// ----------------------------------------------------------------
// Deterministic FALLBACK result builder (§3.3, storyboard-first variant)
//
// Used when the LLM director fails or returns an invalid storyboard. Always
// emits a valid storyboard + one sentence per word so the cloze UI is
// guaranteed to have non-empty sentences even on a fallback path.
// ----------------------------------------------------------------
export interface FusionFallbackSentence {
  word: string;
  sentence: string;
}

export interface FusionFallbackResult {
  /** The image-generation prompt (text-only, no mascot reference). */
  prompt: string;
  /** A storyboard (N sentences, each containing 1 target word verbatim). */
  storyboard: string;
  /** One cloze sentence per input word, containing `word` verbatim. */
  sentences: FusionFallbackSentence[];
}

/**
 * Build the fallback image-generation prompt (deterministic — no LLM).
 * Mirrors the legacy buildFusionPrompt so we don't change image quality on
 * the fallback path; only the storyboard + sentences are new.
 */
const buildFallbackImagePrompt = (words: SceneWordInput[], dayIndex: number): string => {
  const mascot = MASCOT_FALLBACK_DESCRIPTIONS[dayIndex] || MASCOT_FALLBACK_DESCRIPTIONS[0];
  const wordList = words.map((w) => w.text).join(', ');
  const wordDetails = words.map((w) => `${w.text} (${w.definitionCn || '—'})`).join(', ');

  return [
    `Create a cartoon-style isometric-perspective illustration of ONE coherent, meaningful scene that naturally incorporates all of the following elements: ${wordDetails}.`,
    `Also include this character as part of the scene: ${mascot}`,
    `Design a single unified scene — NOT a grid, NOT separate boxes or panels — where all these elements coexist naturally and tell a visual story. For example: if the words include "fountain", "truck", and "mountain", depict a mountain landscape with a fountain in a town square and a truck driving through — all in one illustration.`,
    `Each element must be clearly visible and identifiable within the scene, but they should interact with each other naturally as part of a cohesive environment, not float in separate cells.`,
    `Isometric perspective, HD, highly detailed, vibrant saturated colors, clean studio lighting, 1:1 square composition.`,
    `Do NOT add floating captions, subtitles, UI labels, watermarks, or text spelling out the words.`,
    `The scene MUST contain these exact ${words.length} elements: ${wordList}.`,
  ].join(' ');
};

/**
 * Build a single fallback cloze sentence for `w`.
 *
 * Returns an EMPTY string — we deliberately do NOT produce a fallback template.
 * The previous template `The word "X" is hidden in today's scene — guess it
 * from the picture.` was meaningless to the learner, wasted TTS resources
 * (every word triggered a TTS call for a useless sentence), and cluttered the
 * REVIEW screen with rows that added no learning value. Instead, words without
 * a real LLM-authored sentence are treated as "picture only" — the client
 * shows a minimal placeholder in PLAYING and just the word itself in REVIEW.
 */
const buildFallbackClozeSentence = (_w: SceneWordInput): string => {
  return '';
};

/**
 * Mirror of the MASCOT_DESCRIPTIONS table in index.ts, kept here so this
 * module stays dependency-free. Kept generic on purpose — the day-specific
 * visual identity comes from the M{dayIndex}.webp reference image attached
 * via img2img multipart, NOT from this text. Used only on the rare fallback
 * path when img2img is unavailable; even then we don't try to describe colors
 * because we can't know which reference image is "correct" for the day.
 */
const MASCOT_FALLBACK_DESCRIPTIONS: Record<number, string> = {
  0: 'A small round plush cartoon monster.',
  1: 'A small round plush cartoon monster.',
  2: 'A small round plush cartoon monster.',
  3: 'A small round plush cartoon monster.',
  4: 'A small round plush cartoon monster.',
  5: 'A small round plush cartoon monster.',
  6: 'A small round plush cartoon monster.',
};

/**
 * Build the full fallback result (image prompt + storyboard + sentences).
 *
 * Storyboard: empty string — without LLM-authored sentences there is nothing
 * meaningful to string together. The PREPARING preview simply hides the
 * storyboard card when it's empty.
 *
 * Sentences: one entry per word, but with an EMPTY sentence string. The edge
 * function's `elementsForEvent` filter drops empty-sentence entries, so the
 * client never receives them and never sends them to TTS. The client shows
 * "Picture only — guess word #N." in PLAYING and just the word itself in
 * REVIEW for these words.
 *
 * The image prompt is still fully generated (deterministic, no LLM) so the
 * image render proceeds normally — the learner at least gets a picture to
 * look at while answering.
 */
export const buildFusionResult = (
  words: SceneWordInput[],
  dayIndex: number,
): FusionFallbackResult => {
  const safeWords = Array.isArray(words) ? words : [];
  const prompt = buildFallbackImagePrompt(safeWords, dayIndex);
  const sentences: FusionFallbackSentence[] = safeWords.map((w) => ({
    word: String(w.text || '').trim(),
    sentence: buildFallbackClozeSentence(w), // empty string — no fallback template
  }));
  const storyboard = ''; // no storyboard without real sentences
  return { prompt, storyboard, sentences };
};
