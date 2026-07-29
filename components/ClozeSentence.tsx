import React, { memo, useMemo } from 'react';

export type ClozeStatus = 'idle' | 'active' | 'correct' | 'wrong' | 'revealed';

interface ClozeSentenceProps {
  sentence: string;
  /** Target word(s) blanked in this row. 1 word = classic single blank; 2 words
   *  = a merged pair (one row, two blanks) to avoid answer-leaking duplicates. */
  targetWords: string[];
  /** Per-word blank status (drives each blank's border/text color). */
  statuses: ClozeStatus[];
  /** Per-word reveal flag — show the original cased word inside its blank. */
  revealedFlags?: boolean[];
  /** Compact / dim the row (non-active rows). Defaults to false. */
  isActive?: boolean;
  /** Click handler — wired by the parent to focus this row. */
  onSelect?: () => void;
  /** Optional blob URL for the sentence's TTS audio. When present, a speaker
   *  icon is rendered at the end of the row. */
  audioUrl?: string | null;
  /** Whether this row's audio is currently playing (controls icon + label). */
  isAudioPlaying?: boolean;
  /** Click handler for the speaker button. Parent owns the <audio> element. */
  onPlayAudio?: () => void;
}

/**
 * Find the first case-insensitive, word-boundary occurrence of `targetWord`
 * inside `sentence`. Returns the [start, end] character offsets, or null when
 * no match exists.
 */
const findWordSpan = (sentence: string, targetWord: string): [number, number] | null => {
  const target = String(targetWord || '').trim().toLowerCase();
  if (!target) return null;
  const haystack = String(sentence || '');
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])(${escaped})(?=[^a-z0-9]|$)`, 'i');
  const m = re.exec(haystack);
  if (!m) return null;
  const leadingLen = m[1] ? m[1].length : 0;
  return [m.index + leadingLen, m.index + leadingLen + m[2].length];
};

type Segment =
  | { type: 'text'; text: string }
  | { type: 'blank'; word: string; status: ClozeStatus; revealed: boolean };

/**
 * Split `sentence` into alternating text + blank segments, one blank per target
 * word found (sorted left-to-right, non-overlapping). Words not found in the
 * sentence (e.g. a "Picture only" placeholder) collapse to a trailing blank so
 * the row still shows an underline. Exported for unit testing.
 */
export const buildClozeSegments = (
  sentence: string,
  targetWords: string[],
  statuses: ClozeStatus[],
  revealedFlags: boolean[],
): Segment[] => {
  const found = targetWords
    .map((w, i) => ({ w, i, span: findWordSpan(sentence, w) }))
    .filter((s) => s.span !== null) as { w: string; i: number; span: [number, number] }[];
  found.sort((a, b) => a.span[0] - b.span[0]);

  // Drop any span that overlaps a previously-accepted one (defensive — distinct
  // target words shouldn't overlap, but guard anyway).
  const accepted: { w: string; i: number; span: [number, number] }[] = [];
  let lastEnd = -1;
  for (const s of found) {
    if (s.span[0] < lastEnd) continue;
    accepted.push(s);
    lastEnd = s.span[1];
  }

  if (accepted.length === 0) {
    // No word matched (e.g. "Picture only — guess word #N." placeholder).
    // Render the sentence text + a single trailing blank so there's an input
    // target, matching the legacy single-blank picture-only behavior.
    const segs: Segment[] = [{ type: 'text', text: String(sentence || '') }];
    if (targetWords.length > 0) {
      segs.push({ type: 'blank', word: targetWords[0], status: statuses[0] || 'idle', revealed: !!revealedFlags[0] });
    }
    return segs;
  }

  const segs: Segment[] = [];
  let cursor = 0;
  for (const a of accepted) {
    if (a.span[0] > cursor) segs.push({ type: 'text', text: sentence.slice(cursor, a.span[0]) });
    segs.push({ type: 'blank', word: a.w, status: statuses[a.i] || 'idle', revealed: !!revealedFlags[a.i] });
    cursor = a.span[1];
  }
  if (cursor < (sentence || '').length) segs.push({ type: 'text', text: sentence.slice(cursor) });
  return segs;
};

const blankBorderClass = (status: ClozeStatus, isActive: boolean): string =>
  status === 'correct'
    ? 'border-electric-green'
    : status === 'wrong'
      ? 'border-red-500'
      : status === 'revealed'
        ? 'border-mid-charcoal'
        : status === 'active' || isActive
          ? 'border-purple-400'
          : 'border-mid-charcoal/60';

const blankTextClass = (status: ClozeStatus): string =>
  status === 'correct' ? 'text-electric-green' : status === 'revealed' ? 'text-text-light' : 'text-transparent';

/**
 * Render a cloze sentence with one or two inline blanks. The target word(s) are
 * replaced with underline placeholders. Per-blank `status` controls color;
 * row-level `isActive` controls size/opacity. This is DISPLAY-only — the player
 * types in a separate LargeWordInput below the sentence list.
 */
const ClozeSentenceImpl: React.FC<ClozeSentenceProps> = ({
  sentence,
  targetWords,
  statuses,
  revealedFlags = [],
  isActive = false,
  onSelect,
  audioUrl,
  isAudioPlaying = false,
  onPlayAudio,
}) => {
  const segments = useMemo(
    () => buildClozeSegments(sentence, targetWords, statuses, revealedFlags),
    [sentence, targetWords, statuses, revealedFlags],
  );

  // Mixed-case body font (Lexend). Active row is ~50% larger than inactive.
  const fontSize = isActive ? '1.4rem' : '0.95rem';
  const opacity = isActive ? 1 : 0.5;

  const rowBgClass = isActive
    ? 'bg-purple-500/15 border border-purple-400/40'
    : statuses.some((s) => s === 'correct')
      ? 'bg-electric-green/5 border border-transparent'
      : statuses.some((s) => s === 'revealed')
        ? 'bg-red-500/5 border border-transparent'
        : 'border border-transparent hover:bg-white/5';

  const renderBlank = (word: string, status: ClozeStatus, revealed: boolean, key: number) => {
    const showWord = revealed && word;
    const blankWidth = `${Math.max(word.length, 4) * 0.6}em`;
    if (showWord) {
      return (
        <span
          key={key}
          className={`inline-block border-b-2 ${blankBorderClass(status, isActive)} ${blankTextClass(status)}`}
          style={{ minWidth: blankWidth, textAlign: 'center', padding: '0 0.15em' }}
        >
          {word}
        </span>
      );
    }
    return (
      <span
        key={key}
        className={`inline-block border-b-2 ${blankBorderClass(status, isActive)}`}
        style={{ minWidth: blankWidth, height: '1em', verticalAlign: 'baseline' }}
        aria-label={`blank for ${word}`}
      />
    );
  };

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-2 rounded-2xl px-3 py-2 transition-all duration-200 ${rowBgClass}`}
      style={{ cursor: onSelect ? 'pointer' : 'default' }}
    >
      <p
        className="flex-1 font-body text-text-light"
        style={{
          fontSize,
          opacity,
          lineHeight: 1.5,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          margin: 0,
        }}
      >
        {segments.map((seg, i) =>
          seg.type === 'text' ? (
            <span key={i}>{seg.text}</span>
          ) : (
            renderBlank(seg.word, seg.status, seg.revealed, i)
          ),
        )}
      </p>
      {audioUrl && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPlayAudio?.(); }}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-mid-charcoal bg-light-charcoal/40 text-text-light transition-colors hover:border-purple-400/60 hover:text-purple-300"
          aria-label={isAudioPlaying ? 'Pause sentence audio' : 'Play sentence audio'}
        >
          <span className="material-symbols-outlined text-base">{isAudioPlaying ? 'pause' : 'volume_up'}</span>
        </button>
      )}
    </div>
  );
};

export const ClozeSentence = memo(ClozeSentenceImpl);

export default ClozeSentence;
