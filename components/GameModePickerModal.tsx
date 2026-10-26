import React, { useMemo } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { WordEntry } from '../types';
import { getPuzzleCandidateWords } from '../services/puzzleGame';
import { toSurfReviewWord } from '../features/monster-surf/reviewVocabulary';

interface GameModePickerModalProps {
  visibleWords: WordEntry[];
  onSelectPuzzle: () => void;
  onClose: () => void;
}

interface GameEntry {
  key: 'puzzle' | 'surf';
  optionLabel: { en: string; zh: string };
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

/** Game entrance for Monster Surf and the nine-cell audio puzzle. */
export const GameModePickerModal: React.FC<GameModePickerModalProps> = ({
  visibleWords,
  onSelectPuzzle,
  onClose,
}) => {
  const surfReadyCount = useMemo(() => new Set(visibleWords.map(toSurfReviewWord).filter(Boolean).map(word => word!.answer)).size, [visibleWords]);
  const puzzleReadyCount = useMemo(
    () => getPuzzleCandidateWords(visibleWords).length,
    [visibleWords]
  );

  const entries: GameEntry[] = [
    {
      key: 'surf', optionLabel: { en: 'Recommended', zh: '推荐' }, titleEn: 'MONSTER SURF', titleZh: '怪兽冲浪',
      descEn: 'Ride with today’s monster and review due words. Entry: 1 coin. Collect Sea Crystals and exchange up to 1 coin per correct word.',
      descZh: '和今日怪兽乘风逐浪，优先复习到期词。入场 1 金币，收集海晶兑换奖励，每答对一词最多兑换 1 金币。',
      icon: 'sports_esports',
      accent: { text: 'text-electric-blue group-hover:text-charcoal', hoverBg: 'hover:bg-electric-blue hover:text-charcoal', border: '' },
      ready: surfReadyCount > 0,
      readyLabel: { en: 'Add an English word with a Chinese meaning first', zh: '请先添加带中文释义的英文单词' },
      onSelect: () => { window.location.assign('/monster-run.html'); },
    },
    {
      key: 'puzzle',
      optionLabel: { en: 'Puzzle', zh: '九宫格' },
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
            text="Review due words through play. Check entry costs and rewards before starting."
            translation="用游戏复习到期单词。开始前可查看各模式的入场花费与奖励规则。"
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
                <HoverTranslationText text={entry.optionLabel.en} translation={entry.optionLabel.zh} />
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
