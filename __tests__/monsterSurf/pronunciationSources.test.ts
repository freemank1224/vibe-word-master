import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPronunciationCandidates, safePronunciationUrl } from '../../services/pronunciationSources.ts';

const project = 'https://mkdxdlsjisqazermmfoe.supabase.co';
const recording = `${project}/storage/v1/object/public/word-audio/ocean.mp3`;
const staleRecording = `${project}/storage/v1/object/public/word-audio/old-ocean.mp3`;
const proxy = `${project}/functions/v1/pronunciation?word=ocean&lang=en&uniqueness_mode=strict`;

test('an existing personal recording takes precedence over a stale cached voice and the proxy', () => {
  assert.deepEqual(buildPronunciationCandidates({
    word: 'ocean', directUrl: recording, cachedUrl: staleRecording, supabaseUrl: project,
  }), [recording, staleRecording, proxy]);
});

test('a word without audio_url still resolves the official shared recording, including demo spellings', () => {
  assert.deepEqual(buildPronunciationCandidates({ word: 'ocean', directUrl: null, supabaseUrl: project }), [proxy]);
  assert.deepEqual(buildPronunciationCandidates({ word: 'unfamiliar', supabaseUrl: project }), [
    `${project}/functions/v1/pronunciation?word=unfamiliar&lang=en&uniqueness_mode=strict`,
  ]);
});

test('canonical duplicate URLs are played only once, including a cached proxy', () => {
  assert.deepEqual(buildPronunciationCandidates({
    word: 'ocean', directUrl: `  ${recording}  `, cachedUrl: recording, supabaseUrl: project,
  }), [recording, proxy]);
  assert.deepEqual(buildPronunciationCandidates({ word: 'ocean', cachedUrl: proxy, supabaseUrl: project }), [proxy]);
});

test('proxy lookup follows the shared normalization and safely encodes words and language', () => {
  const [candidate] = buildPronunciationCandidates({
    word: '  ICE\t CREAM & SUN  ', lang: 'en-GB', uniquenessMode: 'relaxed', supabaseUrl: `${project}/`,
  });
  const url = new URL(candidate);
  assert.equal(url.origin, project);
  assert.equal(url.pathname, '/functions/v1/pronunciation');
  assert.deepEqual([...url.searchParams], [
    ['word', 'ice cream & sun'], ['lang', 'en-GB'], ['uniqueness_mode', 'relaxed'],
  ]);
});

test('invalid direct/cache URLs cannot bypass official recorded pronunciation', () => {
  for (const unsafe of [
    'javascript:alert(1)', 'data:audio/mp3;base64,AAAA', 'file:///tmp/ocean.mp3',
    '/monster-surf/audio/ocean.m4a', '//example.com/ocean.mp3',
    'https://user:password@example.com/audio.mp3', 'not a URL',
  ]) {
    assert.equal(safePronunciationUrl(unsafe), null);
    assert.deepEqual(buildPronunciationCandidates({
      word: 'ocean', directUrl: unsafe, cachedUrl: unsafe, supabaseUrl: project,
    }), [proxy]);
  }
});

test('the generated endpoint requires an official credential-free HTTPS project base', () => {
  for (const base of [
    'http://mkdxdlsjisqazermmfoe.supabase.co', 'https://supabase.co',
    'https://mkdxdlsjisqazermmfoe.supabase.co.evil.example',
    'https://evil.example/path/mkdxdlsjisqazermmfoe.supabase.co',
    'https://user:secret@mkdxdlsjisqazermmfoe.supabase.co',
    'https://mkdxdlsjisqazermmfoe.supabase.co:444',
  ]) {
    assert.deepEqual(buildPronunciationCandidates({ word: 'ocean', directUrl: recording, supabaseUrl: base }), [recording]);
  }
});

test('missing configuration or an empty word never substitutes local speech or prototype audio', () => {
  assert.deepEqual(buildPronunciationCandidates({ word: 'ocean' }), []);
  assert.deepEqual(buildPronunciationCandidates({ word: '  ', directUrl: recording, supabaseUrl: project }), []);
  assert.equal(safePronunciationUrl(null), null);
  assert.equal(safePronunciationUrl(undefined), null);
  assert.equal(safePronunciationUrl('https://EXAMPLE.com:443/audio.mp3'), 'https://example.com/audio.mp3');
  assert.equal(safePronunciationUrl('http://example.com/audio.mp3'), 'http://example.com/audio.mp3');
});
