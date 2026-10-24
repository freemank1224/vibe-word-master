import React, { useMemo } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { WordEntry } from '../types';
import { getWordStrikeCandidateWords, WORD_STRIKE_MIN_WORDS } from '../services/wordStrike';
import { toWordOrbitQuestion } from '../services/wordOrbit';
import { getPuzzleCandidateWords } from '../services/puzzleGame';

interface GameModePickerModalProps {
  visibleWords: WordEntry[];
  onSelectOrbit: () => void;
  onSelectStrike: () => void;
  onSelectPuzzle: () => void;
  onClose: () => void;
}

interface GameEntry {
  key: 'strike' | 'puzzle' | 'orbit';
  optionLabel: string;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  icon: string;
  accent: {
    /** enabled card hover + title tint */
    text: string;
    hoverBg: string;
    border: string;
  };
  ready: boolean;
  readyLabel: { en: string; zh: string };
  onSelect: () => void;
}

/**
 * GAME MODE picker — hosts the two game modes. Games used to be options 3/4
 * of the Quick Test modal; they were split out so QUICK TEST stays a pure
 * test-range chooser and this modal becomes the arcade entrance.
 *
 * Each entry carries its own readiness gate, mirroring the old inline checks:
 *   strike ≥ 5 plain words · puzzle ≥ 9 image words
 */
export const GameModePickerModal: React.FC<GameModePickerModalProps> = ({
  visibleWords,
  onSelectOrbit,
  onSelectStrike,
  onSelectPuzzle,
  onClose,
}) => {
  const strikeReadyCount = useMemo(() => getWordStrikeCandidateWords(visibleWords).length, [visibleWords]);
  const orbitReadyCount = useMemo(() => new Set(visibleWords.map(toWordOrbitQuestion).filter(Boolean).map(question => question!.answer)).size, [visibleWords]);
  const puzzleReadyCount = useMemo(
    () => getPuzzleCandidateWords(visibleWords).length,
    [visibleWords]
  );

  const entries: GameEntry[] = [
    {
      key: 'orbit', optionLabel: 'Recommended', titleEn: 'WORD ORBIT', titleZh: '星词漫游',
      descEn: `Run across a small planet. Fill a word to vault, slide or jet across obstacles. ${orbitReadyCount} words ready.`,
      descZh: `第三人称星球跑酷：填对越障，答错摔跤后继续。可用词 ${orbitReadyCount} 个，练习进度自动保存。`,
      icon: 'rocket_launch',
      accent: { text: 'text-electric-green group-hover:text-charcoal', hoverBg: 'hover:bg-electric-green hover:text-charcoal', border: '' },
      ready: orbitReadyCount > 0,
      readyLabel: { en: 'Add an English word with a definition first', zh: '请先添加带释义的英文单词' },
      onSelect: onSelectOrbit,
    },
    {
      key: 'strike',
      optionLabel: 'Game 1',
      titleEn: 'WORD STRIKE',
      titleZh: '单词射击（旧版）',
      descEn: `A physics typing-shooter. Type the word, press Enter, shatter the falling brick. Ready words: ${strikeReadyCount}.`,
      descZh: `物理打字射击：拼出单词按回车开火，击碎下落的单词砖。当前可用单词：${strikeReadyCount}。`,
      icon: 'gps_fixed',
      accent: { text: 'text-electric-green group-hover:text-charcoal', hoverBg: 'hover:bg-electric-green hover:text-charcoal', border: '' },
      ready: strikeReadyCount >= WORD_STRIKE_MIN_WORDS,
      readyLabel: { en: `Needs ≥ ${WORD_STRIKE_MIN_WORDS} plain words`, zh: `至少需要 ${WORD_STRIKE_MIN_WORDS} 个纯字母单词` },
      onSelect: onSelectStrike,
    },
    {
      key: 'puzzle',
      optionLabel: 'Game 2',
      titleEn: 'PUZZLE GAME',
      titleZh: '九格连线',
      descEn: `A 90-second 3x3 audio puzzle using 9 image words. Ready words: ${puzzleReadyCount}.`,
      descZh: `用 9 个带图单词进行 90 秒九宫格听音字谜。当前可用带图词：${puzzleReadyCount}。`,
      icon: 'grid_3x3',
      accent: { text: 'text-electric-blue group-hover:text-charcoal', hoverBg: 'hover:bg-electric-blue hover:text-charcoal', border: '' },
      ready: puzzleReadyCount >= 9,
      readyLabel: { en: 'Needs ≥ 9 image words', zh: '至少需要 9 个带图单词' },
      onSelect: onSelectPuzzle,
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="bg-light-charcoal border border-mid-charcoal rounded-3xl p-8 max-w-md w-full shadow-2xl scale-in-center max-h-[90vh] overflow-y-auto custom-scrollbar">
        <h3 className="text-3xl font-headline text-white mb-2 tracking-tight">
          <HoverTranslationText text="GAME MODE" translation="游戏模式" />
        </h3>
        <p className="text-text-dark font-body mb-8">
          <HoverTranslationText
            text="Practice due words through play. New game rules save learning progress as practice."
            translation="用游戏复习到期单词。新玩法先以练习局保存学习进度。"
          />
        </p>

        <div className="grid gap-4">
          {entries.map((entry) => (
            <button
              key={entry.key}
              onClick={entry.onSelect}
              disabled={!entry.ready}
              className={`transition-all p-6 rounded-2xl flex flex-col items-start gap-1 group text-left ${
                entry.ready
                  ? `bg-mid-charcoal ${entry.accent.hoverBg}`
                  : 'bg-mid-charcoal/50 border border-dashed border-mid-charcoal text-text-dark cursor-not-allowed'
              }`}
            >
              <span className={`flex items-center gap-2 text-sm font-mono uppercase tracking-widest ${
                entry.ready ? entry.accent.text : 'text-text-dark'
              }`}>
                <span className="material-symbols-outlined text-[18px]">{entry.icon}</span>
                <HoverTranslationText text={entry.optionLabel} translation={entry.optionLabel === 'Recommended' ? '推荐' : entry.optionLabel === 'Game 1' ? '旧版' : '九宫格'} />
              </span>
              <span className="text-xl font-headline group-hover:text-charcoal">
                <HoverTranslationText text={entry.titleEn} translation={entry.titleZh} />
              </span>
              <span className="text-xs opacity-50 font-body group-hover:text-charcoal/70">
                <HoverTranslationText
                  text={entry.ready ? entry.descEn : `${entry.readyLabel.en}. ${entry.descEn}`}
                  translation={entry.ready ? entry.descZh : `${entry.readyLabel.zh}。${entry.descZh}`}
                />
              </span>
            </button>
          ))}

          <button
            onClick={onClose}
            className="mt-4 text-text-dark hover:text-white transition-colors uppercase font-mono text-xs tracking-[0.2em]"
          >
            <HoverTranslationText text="Maybe Later" translation="稍后再说" />
          </button>
        </div>
      </div>
    </div>
  );
};
