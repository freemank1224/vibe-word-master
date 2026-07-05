import React, { useMemo } from 'react';

export type ClozeStatus = 'idle' | 'active' | 'correct' | 'wrong' | 'revealed';

interface ClozeSentenceProps {
  sentence: string;
  targetWord: string;
  /** Visual state of the blank. 'active' enlarges and highlights. */
  status?: ClozeStatus;
  /** When true, show the original cased target word inside the blank. */
  revealed?: boolean;
  /** Compact / dim the row (non-active rows). Defaults to false. */
  isActive?: boolean;
  /** Click handler — wired by the parent to focus this row. */
  onSelect?: () => void;
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

/**
 * Render a cloze sentence. The target word is replaced with an inline
 * underline placeholder. Visual state controls emphasis:
 *
 *   - active: large font (font-body), full opacity, accent background
 *   - inactive: smaller font, dimmed
 *   - correct: green tint background + word visible in green
 *   - wrong: red border flash
 *   - revealed: gray word visible (after 3 wrong guesses)
 *
 * NOTE: This is a DISPLAY-only component. The player types in a separate
 * LargeWordInput below the sentence list (mirrors CLASSIC test style).
 */
export const ClozeSentence: React.FC<ClozeSentenceProps> = ({
  sentence,
  targetWord,
  status = 'idle',
  revealed = false,
  isActive = false,
  onSelect,
}) => {
  const parts = useMemo<{ prefix: string; matched: string; suffix: string }>(() => {
    const span = findWordSpan(sentence, targetWord);
    if (!span) {
      return { prefix: sentence, matched: '', suffix: '' };
    }
    return {
      prefix: sentence.slice(0, span[0]),
      matched: sentence.slice(span[0], span[1]),
      suffix: sentence.slice(span[1]),
    };
  }, [sentence, targetWord]);

  // Mixed-case body font (Lexend). Avoid font-headline (Bebas Neue) which
  // renders ALL glyphs as capitals.
  const fontSize = isActive ? '1.15rem' : '0.95rem';
  const opacity = isActive ? 1 : 0.5;

  // Outer row container — clickable + accent background on active.
  const rowBgClass = isActive
    ? 'bg-purple-500/15 border border-purple-400/40'
    : status === 'correct'
      ? 'bg-electric-green/5 border border-transparent'
      : status === 'revealed'
        ? 'bg-red-500/5 border border-transparent'
        : 'border border-transparent hover:bg-white/5';

  // Inline blank styling.
  const blankBorderClass =
    status === 'correct'
      ? 'border-electric-green'
      : status === 'wrong'
        ? 'border-red-500'
        : status === 'revealed'
          ? 'border-mid-charcoal'
          : isActive
            ? 'border-purple-400'
            : 'border-mid-charcoal/60';

  const blankTextClass =
    status === 'correct'
      ? 'text-electric-green'
      : status === 'revealed'
        ? 'text-text-light'
        : 'text-transparent';

  const blankWidth = `${Math.max(parts.matched.length, 4) * 0.6}em`;

  return (
    <div
      onClick={onSelect}
      className={`rounded-2xl px-3 py-2 transition-all duration-200 ${rowBgClass}`}
      style={{
        cursor: onSelect ? 'pointer' : 'default',
      }}
    >
      <p
        className="font-body text-text-light"
        style={{
          fontSize,
          opacity,
          lineHeight: 1.5,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          margin: 0,
        }}
      >
        {parts.prefix}
        {(status === 'correct' || status === 'revealed') && parts.matched ? (
          <span
            className={`inline-block border-b-2 ${blankBorderClass} ${blankTextClass}`}
            style={{ minWidth: blankWidth, textAlign: 'center', padding: '0 0.15em' }}
          >
            {parts.matched}
          </span>
        ) : (
          <span
            className={`inline-block border-b-2 ${blankBorderClass}`}
            style={{ minWidth: blankWidth, height: '1em', verticalAlign: 'baseline' }}
            aria-label={`blank for ${targetWord}`}
          />
        )}
        {parts.suffix}
      </p>
    </div>
  );
};

export default ClozeSentence;
