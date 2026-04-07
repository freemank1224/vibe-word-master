import React from 'react';
import { HoverTranslationText } from '../HoverTranslationText';
import { AccountPanelStats } from './types';

interface StatsOverviewSectionProps {
  stats: AccountPanelStats;
}

export const StatsOverviewSection: React.FC<StatsOverviewSectionProps> = ({ stats }) => {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50">
          <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2"><HoverTranslationText text="Total Words" translation="总单词数" /></div>
          <div className="text-3xl font-headline text-white">{stats.totalWords}</div>
        </div>
        <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50">
          <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2"><HoverTranslationText text="Global Accuracy" translation="总体正确率" /></div>
          <div className="text-3xl font-headline text-electric-green">{Math.round(stats.accuracy)}%</div>
        </div>
        <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50">
          <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2"><HoverTranslationText text="Library Coverage" translation="词库覆盖率" /></div>
          <div className="text-3xl font-headline text-electric-blue">{Math.round(stats.coverage)}%</div>
        </div>
        <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50 border-orange-500/30">
          <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2"><HoverTranslationText text="Daily Streak" translation="连续打卡天数" /></div>
          <div className="text-3xl font-headline text-orange-400">{stats.currentStreak} <span className="text-xl">🔥</span></div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase"><HoverTranslationText text="Metrics Detail" translation="详细指标" /></h3>
        <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30 divide-y divide-mid-charcoal/30">
          <div className="flex justify-between py-3">
            <span className="text-text-light text-sm"><HoverTranslationText text="Active Duration" translation="活跃时长" /></span>
            <span className="text-white font-mono text-sm">{stats.daysSinceStart} Days</span>
          </div>
          <div className="flex justify-between py-3">
            <span className="text-text-light text-sm"><HoverTranslationText text="Tested Items" translation="已测试项目" /></span>
            <span className="text-white font-mono text-sm">{stats.testedWords}</span>
          </div>
          <div className="flex justify-between py-3">
            <span className="text-text-light text-sm"><HoverTranslationText text="Mastered Words" translation="已掌握单词" /></span>
            <span className="text-white font-mono text-sm font-bold text-electric-green">{stats.correctWords}</span>
          </div>
        </div>
      </div>
    </>
  );
};
