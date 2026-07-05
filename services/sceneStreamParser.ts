// ================================================================
// sceneStreamParser.ts — pure NDJSON parser for scene-generate.
//
// Extracted from sceneGame.ts so it can be unit-tested under Node's native
// `--test` runner without pulling in transitive imports (supabaseClient,
// adaptiveWordSelector) that rely on `@/` path aliases Node doesn't resolve.
//
// ZERO third-party deps; only imports types from `../types`.
// ================================================================
import type {
  SceneAsset,
  ScenePipelineStage,
  WordRegion,
} from '../types';

export interface SceneGenerationResult {
  source: 'cache-hit' | 'generated';
  asset: SceneAsset;
  degraded: boolean;
}

export type { ScenePipelineStage } from '../types';

export interface SceneGenerationCallbacks {
  onStage?: (stage: ScenePipelineStage, payload: any) => void;
}

/** Normalize a raw edge-function asset payload into a typed SceneAsset. */
export const normalizeAsset = (raw: any): SceneAsset => {
  const regions: WordRegion[] = (Array.isArray(raw?.regions) ? raw.regions : []).map((r: any) => {
    const region: WordRegion = {
      word: String(r?.word || ''),
      x: Number(r?.x) || 0,
      y: Number(r?.y) || 0,
      w: Number(r?.w) || 0,
      h: Number(r?.h) || 0,
      confidence: Number(r?.confidence) || 0,
      detectionFailed: Boolean(r?.detectionFailed),
    };
    if (typeof r?.sentence === 'string' && r.sentence.trim()) {
      region.sentence = r.sentence.trim();
    }
    return region;
  });

  // Build the sentences index. Region.sentence takes priority; fall back to
  // scene_design.elements[].sentence for any word missing a region sentence.
  const sentences: Record<string, string> = {};
  for (const region of regions) {
    if (region.sentence) {
      sentences[region.word.toLowerCase()] = region.sentence;
    }
  }
  const elementsFallback = raw?.scene_design?.elements;
  if (Array.isArray(elementsFallback)) {
    for (const el of elementsFallback) {
      if (!el || typeof el !== 'object') continue;
      const word = typeof el.word === 'string' ? el.word.trim().toLowerCase() : '';
      if (!word) continue;
      if (sentences[word]) continue; // region sentence already won
      if (typeof el.sentence === 'string' && el.sentence.trim()) {
        sentences[word] = el.sentence.trim();
      }
    }
  }

  const asset: SceneAsset = {
    id: String(raw?.id || ''),
    wordSetHash: String(raw?.word_set_hash || raw?.wordSetHash || ''),
    dayIndex: Number(raw?.day_index ?? raw?.dayIndex ?? 0),
    language: String(raw?.language || 'en'),
    imageUrl: String(raw?.public_url || raw?.imageUrl || raw?.publicUrl || ''),
    storagePath: String(raw?.storage_path || raw?.storagePath || ''),
    prompt: String(raw?.prompt || ''),
    regions,
    model: String(raw?.model || ''),
    visionModel: String(raw?.vision_model || raw?.visionModel || ''),
    status: raw?.status === 'failed' ? 'failed' : 'ready',
    createdAt: String(raw?.created_at || raw?.createdAt || ''),
  };
  if (Object.keys(sentences).length > 0) {
    asset.sentences = sentences;
  }
  // Forward the AI-generated storyboard (storyboard-first director output) when
  // present. Stored on `scene_design.storyboard` in the DB and passed through
  // the edge function's done-event payload under `sceneDesign.storyboard`.
  const storyboard =
    typeof raw?.sceneDesign?.storyboard === 'string'
      ? raw.sceneDesign.storyboard.trim()
      : typeof raw?.scene_design?.storyboard === 'string'
        ? raw.scene_design.storyboard.trim()
        : '';
  if (storyboard) {
    asset.storyboard = storyboard;
  }
  return asset;
};

/**
 * Parse the NDJSON event stream returned by scene-generate. Exposed for unit
 * tests that want to verify stage ordering / error handling without spinning
 * up the edge function.
 *
 * Stages fired via callbacks.onStage:
 *   - 'designed'  : director returned a prompt
 *   - 'rendered'  : image provider returned bytes
 *   - 'persisted' : scene_assets row written
 *   - 'done'      : final asset is ready
 *
 * Throws on `error` events, malformed done events (missing asset / empty URL),
 * or if the stream ends without a `done` event.
 */
export const parseSceneGenerateNdjsonStream = async (
  stream: ReadableStream<Uint8Array>,
  callbacks?: SceneGenerationCallbacks,
): Promise<SceneGenerationResult> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalAsset: SceneAsset | null = null;
  let finalSource: 'cache-hit' | 'generated' = 'generated';
  let finalDegraded = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        console.warn('[sceneGame] failed to parse NDJSON line:', line.substring(0, 120));
        continue;
      }
      const stage = String(event?.stage || '');
      console.log('[sceneGame] ndjson event', { stage, source: event?.source, fallbackReason: event?.fallbackReason || '', hasAsset: !!event?.asset, imageUrl: event?.asset?.imageUrl || event?.asset?.public_url || '' });
      if (stage === 'designed' && event?.fallbackReason) {
        console.warn('[sceneGame] director fallback reason:', event.fallbackReason);
      }
      if (stage === 'designed' || stage === 'rendered' || stage === 'persisted') {
        callbacks?.onStage?.(stage as ScenePipelineStage, event);
      } else if (stage === 'done') {
        callbacks?.onStage?.('done', event);
        if (!event.asset) throw new Error('scene-generate done event missing asset');
        const asset = normalizeAsset(event.asset);
        if (!asset.imageUrl) throw new Error('scene-generate returned empty imageUrl');
        finalAsset = asset;
        finalSource = event.source === 'cache-hit' ? 'cache-hit' : 'generated';
        finalDegraded = Boolean(event.degraded);
      } else if (stage === 'error') {
        const failedAt = event?.failedStage || 'unknown';
        const message = event?.error || `scene-generate failed at ${failedAt}`;
        throw new Error(String(message));
      }
    }
  }

  if (!finalAsset) throw new Error('scene-generate stream ended without done event');
  return { source: finalSource, asset: finalAsset, degraded: finalDegraded };
};
