import React from 'react';
import { WordEntry } from '../../types';
import { ProgressPieChart, MasteryPieChart } from '../Charts';
import { HoverTranslationText } from '../HoverTranslationText';
import { AccountChartTab } from './types';

interface LearningAnalyticsSectionProps {
  words: WordEntry[];
  activeChartTab: AccountChartTab;
  onTabChange: (tab: AccountChartTab) => void;
}

export const LearningAnalyticsSection: React.FC<LearningAnalyticsSectionProps> = ({ words, activeChartTab, onTabChange }) => {
  return (
    <div className="space-y-4">
      <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase"><HoverTranslationText text="Learning Analytics" translation="学习分析" /></h3>

      <div className="flex gap-2 bg-dark-charcoal p-1.5 rounded-2xl border border-mid-charcoal/30">
        <button
          onClick={() => onTabChange('progress')}
          className={`flex-1 py-2.5 px-4 rounded-xl font-mono text-xs uppercase tracking-wider transition-all duration-300 ${
            activeChartTab === 'progress'
              ? 'bg-electric-blue text-white shadow-[0_0_15px_rgba(59,130,246,0.4)]'
              : 'text-text-dark hover:text-white'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">analytics</span>
            <HoverTranslationText text="Test Coverage" translation="测试覆盖率" />
          </span>
        </button>
        <button
          onClick={() => onTabChange('mastery')}
          className={`flex-1 py-2.5 px-4 rounded-xl font-mono text-xs uppercase tracking-wider transition-all duration-300 ${
            activeChartTab === 'mastery'
              ? 'bg-electric-green text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]'
              : 'text-text-dark hover:text-white'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">school</span>
            <HoverTranslationText text="Mastery Level" translation="掌握程度" />
          </span>
        </button>
      </div>

      <div className="bg-light-charcoal/30 p-6 rounded-3xl border border-mid-charcoal/50">
        {activeChartTab === 'progress' ? (
          <div className="flex flex-col items-center">
            <div className="text-center mb-4">
              <p className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-1">
                <HoverTranslationText text="Vocabulary Coverage" translation="词汇覆盖率" />
              </p>
              <p className="text-xs text-text-light leading-relaxed">
                <HoverTranslationText text="Track your progress through the entire word library" translation="跟踪你在整个词库中的学习进度" />
              </p>
            </div>
            <ProgressPieChart words={words} />
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <div className="text-center mb-4">
              <p className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-1">
                <HoverTranslationText text="Word Mastery Distribution" translation="单词掌握分布" />
              </p>
              <p className="text-xs text-text-light leading-relaxed">
                <HoverTranslationText text="See how many words you've mastered vs still learning" translation="查看你已掌握和仍在学习的单词数量" />
              </p>
            </div>
            <MasteryPieChart words={words} />
          </div>
        )}
      </div>
    </div>
  );
};
