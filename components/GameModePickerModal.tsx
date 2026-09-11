import React, { useMemo } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { WordEntry } from '../types';
import { getWordStrikeCandidateWords, WORD_STRIKE_MIN_WORDS } from '../services/wordStrike';

interface GameModePickerModalProps {
  visibleWords: WordEntry[];
  onSelectStrike: () => void;
  onSelectPuzzle: () => void;
  onSelectScene: () => void;
  onClose: () => void;
}

interface GameEntry {
  key: 'strike' | 'puzzle' | 'scene';
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
 * GAME MODE picker — hosts the three game modes. Games used to be options 3/4
 * of the Quick Test modal; they were split out so QUICK TEST stays a pure
 * test-range chooser and this modal becomes the arcade entrance.
 *
 * Each entry carries its own readiness gate, mirroring the old inline checks:
 *   strike ≥ 5 plain words · puzzle ≥ 9 image words · scene ≥ 5 words
 */
export const GameModePickerModal: React.FC<GameModePickerModalProps> = ({
  visibleWords,
  onSelectStrike,
  onSelectPuzzle,
  onSelectScene,
  onClose,
}) => {
  const strikeReadyCount = useMemo(() => getWordStrikeCandidateWords(visibleWords).length, [visibleWords]);
  const puzzleReadyCount = useMemo(
    () => visibleWords.filter(w => (w.image_url || w.image_path) && !w.deleted).length,
    [visibleWords]
  );
  const sceneReadyCount = useMemo(() => visibleWords.filter(w => !w.deleted).length, [visibleWords]);

  const entries: GameEntry[] = [
    {
      key: 'strike',
      optionLabel: 'Game 1',
      titleEn: 'WORD STRIKE',
      titleZh: '单词射击',
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
      titleZh: '字谜游戏',
      descEn: `A 90-second 3x3 audio puzzle using 9 image words. Ready words: ${puzzleReadyCount}.`,
      descZh: `用 9 个带图单词进行 90 秒九宫格听音字谜。当前可用带图词：${puzzleReadyCount}。`,
      icon: 'grid_3x3',
      accent: { text: 'text-electric-blue group-hover:text-charcoal', hoverBg: 'hover:bg-electric-blue hover:text-charcoal', border: '' },
      ready: puzzleReadyCount >= 9,
      readyLabel: { en: 'Needs ≥ 9 image words', zh: '至少需要 9 个带图单词' },
      onSelect: onSelectPuzzle,
    },
    {
      key: 'scene',
      optionLabel: 'Game 3',
      titleEn: 'SCENE FUSION GAME',
      titleZh: '场景融合游戏',
      descEn: `AI fuses 5-10 words into one isometric scene and writes a cloze sentence per word. Available words: ${sceneReadyCount}.`,
      descZh: `AI 把 5-10 个单词融合成一张等轴场景图，并为每个单词生成一句填空。当前可用单词：${sceneReadyCount}。`,
      icon: 'auto_awesome_motion',
      accent: { text: 'text-purple-400 group-hover:text-white', hoverBg: 'hover:bg-purple-500 hover:text-white', border: '' },
      ready: sceneReadyCount >= 5,
      readyLabel: { en: 'Needs ≥ 5 words', zh: '至少需要 5 个单词' },
      onSelect: onSelectScene,
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
            text="Pick a game to drill your words — each mode has its own leaderboard."
            translation="选择一个游戏来练习单词——每种模式都有独立排行榜。"
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
                <HoverTranslationText text={entry.optionLabel} translation={entry.optionLabel === 'Game 1' ? '游戏 1' : entry.optionLabel === 'Game 2' ? '游戏 2' : '游戏 3'} />
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
