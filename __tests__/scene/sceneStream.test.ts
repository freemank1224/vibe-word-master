/**
 * Unit tests for the NDJSON stream parser used by scene-generate.
 *
 * Validates the real-evidence stage progression contract:
 *   - 'designed'  fires exactly once after the director returns
 *   - 'rendered'  fires exactly once after the image provider returns
 *   - 'persisted' fires exactly once after scene_assets is written
 *   - 'done'      fires last, carrying the final asset
 *   - 'error'     short-circuits the stream with a throw
 *
 * The parser is pure with respect to a ReadableStream<Uint8Array>, so we can
 * test it without mocking fetch or Supabase auth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneGenerateNdjsonStream } from '../../services/sceneGame.ts';

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
const ndjsonStream = (lines: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const chunks = lines.map((l) => encoder.encode(l + '\n'));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
};

const collectStages = async (
  lines: string[],
): Promise<{ stages: string[]; result: any }> => {
  const stages: string[] = [];
  const result = await parseSceneGenerateNdjsonStream(ndjsonStream(lines), {
    onStage: (stage) => stages.push(stage),
  });
  return { stages, result };
};

const VALID_ASSET = {
  id: 'asset-1',
  word_set_hash: 'abc123',
  day_index: 2,
  language: 'en',
  public_url: 'https://example.supabase.co/storage/v1/object/public/word-images/scenes/u1/2/abc.png',
  storage_path: 'scenes/u1/2/abc.png',
  prompt: 'isometric scene...',
  regions: [],
  model: 'gpt-image-2',
  status: 'ready',
  created_at: '2025-01-01T00:00:00Z',
};

// ----------------------------------------------------------------
// Happy paths
// ----------------------------------------------------------------
test('full generated pipeline fires designed → rendered → persisted → done in order', async () => {
  const { stages, result } = await collectStages([
    JSON.stringify({ stage: 'designed', prompt: 'p', source: 'director' }),
    JSON.stringify({ stage: 'rendered', providerId: 'letsmakesail' }),
    JSON.stringify({ stage: 'persisted' }),
    JSON.stringify({ stage: 'done', source: 'generated', asset: VALID_ASSET, degraded: false }),
  ]);
  assert.deepEqual(stages, ['designed', 'rendered', 'persisted', 'done']);
  assert.equal(result.source, 'generated');
  assert.equal(result.degraded, false);
  assert.equal(result.asset.imageUrl, VALID_ASSET.public_url);
});

test('cache-hit emits only a single done event (no designed/rendered/persisted)', async () => {
  const { stages, result } = await collectStages([
    JSON.stringify({ stage: 'done', source: 'cache-hit', asset: VALID_ASSET, degraded: false }),
  ]);
  assert.deepEqual(stages, ['done']);
  assert.equal(result.source, 'cache-hit');
});

test('fallback director path still emits designed with source=fallback', async () => {
  const { stages } = await collectStages([
    JSON.stringify({ stage: 'designed', prompt: 'p', source: 'fallback' }),
    JSON.stringify({ stage: 'rendered', providerId: 'newapi' }),
    JSON.stringify({ stage: 'persisted' }),
    JSON.stringify({ stage: 'done', source: 'generated', asset: VALID_ASSET }),
  ]);
  assert.deepEqual(stages, ['designed', 'rendered', 'persisted', 'done']);
});

test('parser handles chunk boundaries that split a JSON line mid-token', async () => {
  // Build a stream where the 'done' line is split across two chunks.
  const encoder = new TextEncoder();
  const doneLine = JSON.stringify({ stage: 'done', source: 'cache-hit', asset: VALID_ASSET }) + '\n';
  const splitAt = Math.floor(doneLine.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(doneLine.slice(0, splitAt)));
      controller.enqueue(encoder.encode(doneLine.slice(splitAt)));
      controller.close();
    },
  });
  const stages: string[] = [];
  const result = await parseSceneGenerateNdjsonStream(stream, {
    onStage: (s) => stages.push(s),
  });
  assert.deepEqual(stages, ['done']);
  assert.equal(result.asset.id, 'asset-1');
});

// ----------------------------------------------------------------
// Error paths
// ----------------------------------------------------------------
test('error event throws with the server-supplied message', async () => {
  await assert.rejects(
    collectStages([
      JSON.stringify({ stage: 'designed', prompt: 'p', source: 'director' }),
      JSON.stringify({ stage: 'error', failedStage: 'rendered', error: 'All image providers failed' }),
    ]),
    /All image providers failed/,
  );
});

test('error event without an explicit message falls back to failedStage label', async () => {
  await assert.rejects(
    collectStages([
      JSON.stringify({ stage: 'error', failedStage: 'persisted' }),
    ]),
    /scene-generate failed at persisted/,
  );
});

test('error event short-circuits — done event after error is never observed', async () => {
  const stages: string[] = [];
  await assert.rejects(
    parseSceneGenerateNdjsonStream(
      ndjsonStream([
        JSON.stringify({ stage: 'error', failedStage: 'rendered', error: 'boom' }),
        JSON.stringify({ stage: 'done', source: 'generated', asset: VALID_ASSET }),
      ]),
      { onStage: (s) => stages.push(s) },
    ),
    /boom/,
  );
  assert.deepEqual(stages, []);
});

// ----------------------------------------------------------------
// Defenses against bad data
// ----------------------------------------------------------------
test('done event with missing asset throws a descriptive error', async () => {
  await assert.rejects(
    collectStages([
      JSON.stringify({ stage: 'persisted' }),
      JSON.stringify({ stage: 'done', source: 'generated' }),
    ]),
    /missing asset/,
  );
});

test('done event with empty public_url throws (blocks black-screen MODE_SELECT)', async () => {
  const badAsset = { ...VALID_ASSET, public_url: '' };
  await assert.rejects(
    collectStages([
      JSON.stringify({ stage: 'done', source: 'generated', asset: badAsset }),
    ]),
    /empty imageUrl/,
  );
});

test('stream that ends without done throws', async () => {
  await assert.rejects(
    collectStages([
      JSON.stringify({ stage: 'designed', prompt: 'p', source: 'director' }),
      JSON.stringify({ stage: 'rendered', providerId: 'x' }),
    ]),
    /ended without done event/,
  );
});

test('malformed JSON lines are skipped (warned), not fatal', async () => {
  const { stages, result } = await collectStages([
    'this is not json',
    JSON.stringify({ stage: 'designed', prompt: 'p', source: 'director' }),
    '',
    JSON.stringify({ stage: 'done', source: 'cache-hit', asset: VALID_ASSET }),
  ]);
  assert.deepEqual(stages, ['designed', 'done']);
  assert.equal(result.source, 'cache-hit');
});

// ----------------------------------------------------------------
// Stage field shapes
// ----------------------------------------------------------------
test('onStage callback receives the full event payload, not just the stage name', async () => {
  const received: any[] = [];
  await parseSceneGenerateNdjsonStream(
    ndjsonStream([
      JSON.stringify({ stage: 'designed', prompt: 'isometric...', source: 'director', sceneTitle: 'Kitchen' }),
      JSON.stringify({ stage: 'rendered', providerId: 'letsmakesail' }),
      JSON.stringify({ stage: 'done', source: 'generated', asset: VALID_ASSET }),
    ]),
    { onStage: (stage, payload) => received.push({ stage, payload }) },
  );
  assert.equal(received.length, 3);
  assert.equal(received[0].stage, 'designed');
  assert.equal(received[0].payload.prompt, 'isometric...');
  assert.equal(received[0].payload.sceneTitle, 'Kitchen');
  assert.equal(received[1].stage, 'rendered');
  assert.equal(received[1].payload.providerId, 'letsmakesail');
});
