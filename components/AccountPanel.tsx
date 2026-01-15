import React, { useMemo, useEffect } from 'react';
import { WordEntry, InputSession } from '../types';
import { calculateAchievements, ACHIEVEMENTS } from '../services/achievementService';
import { Badge } from './Achievements/Badge';

interface AccountPanelProps {
  user: any;
  words: WordEntry[];
  sessions: InputSession[];
  onClose: () => void;
  onLogout: () => void;
}

export const AccountPanel: React.FC<AccountPanelProps> = ({ user, words, sessions, onClose, onLogout }) => {
  useEffect(() => {
    // 锁定主页面滚动
    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = 'hidden';
    
    return () => {
      // 恢复主页面滚动
      document.body.style.overflow = originalStyle;
    };
  }, []);

  const stats = useMemo(() => {
    const totalWords = words.length;
    const testedWords = words.filter(w => w.tested);
    const correctWords = words.filter(w => w.correct);
    const coverage = totalWords > 0 ? (testedWords.length / totalWords) * 100 : 0;
    const accuracy = testedWords.length > 0 ? (correctWords.length / testedWords.length) * 100 : 0;
    
    // 获取成就统计（包含 streak 等信息）
    const achievementStatuses = calculateAchievements(words, sessions);
    
    // 计算使用时长（天）
    const firstSession = sessions.length > 0 
      ? Math.min(...sessions.map(s => s.timestamp)) 
      : Date.now();
    const daysSinceStart = Math.max(1, Math.ceil((Date.now() - firstSession) / (1000 * 60 * 60 * 24)));

    // 从成就逻辑中获取当前连击数
    const streakStatus = achievementStatuses.find(s => s.id === 'p_consistency');
    const currentStreak = streakStatus ? streakStatus.currentProgress : 0;

    return {
      totalWords,
      testedWords: testedWords.length,
      correctWords: correctWords.length,
      coverage,
      accuracy,
      daysSinceStart,
      currentStreak,
      achievementStatuses
    };
  }, [words, sessions]);

  const unlockedCount = stats.achievementStatuses.filter(s => s.unlocked).length;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-end">
      {/* 遮罩层 */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose}></div>

      {/* 面板主内容 */}
      <div className="relative h-full w-full max-w-md bg-dark-charcoal border-l border-mid-charcoal shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
        
        {/* 顶部个人信息 */}
        <div className="p-8 border-b border-mid-charcoal flex justify-between items-center bg-light-charcoal/30">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-electric-blue/20 flex items-center justify-center border border-electric-blue/40 shadow-[0_0_15px_rgba(0,240,255,0.2)]">
              <span className="material-symbols-outlined text-electric-blue text-3xl">account_circle</span>
            </div>
            <div>
              <h2 className="text-white font-headline text-2xl tracking-widest">MONSTER INFO</h2>
              <p className="text-text-dark font-mono text-sm">{user?.email}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-text-dark hover:text-white transition-colors p-2">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* 滚动内容区 */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-8 space-y-10 custom-scrollbar">
          
          {/* 核心统计卡片组 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50">
              <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2">Total Words</div>
              <div className="text-3xl font-headline text-white">{stats.totalWords}</div>
            </div>
            <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50">
              <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2">Global Accuracy</div>
              <div className="text-3xl font-headline text-electric-green">{Math.round(stats.accuracy)}%</div>
            </div>
            <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50">
              <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2">Library Coverage</div>
              <div className="text-3xl font-headline text-electric-blue">{Math.round(stats.coverage)}%</div>
            </div>
            <div className="bg-light-charcoal/50 p-5 rounded-3xl border border-mid-charcoal/50 border-orange-500/30">
              <div className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-2">Daily Streak</div>
              <div className="text-3xl font-headline text-orange-400">{stats.currentStreak} <span className="text-xl">🔥</span></div>
            </div>
          </div>

          {/* 详细成长指标 */}
          <div className="space-y-4">
             <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">Metrics Detail</h3>
             <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30 divide-y divide-mid-charcoal/30">
                <div className="flex justify-between py-3">
                    <span className="text-text-light text-sm">Active Duration</span>
                    <span className="text-white font-mono text-sm">{stats.daysSinceStart} Days</span>
                </div>
                <div className="flex justify-between py-3">
                    <span className="text-text-light text-sm">Tested Items</span>
                    <span className="text-white font-mono text-sm">{stats.testedWords}</span>
                </div>
                <div className="flex justify-between py-3">
                    <span className="text-text-light text-sm">Mastered Words</span>
                    <span className="text-white font-mono text-sm font-bold text-electric-green">{stats.correctWords}</span>
                </div>
             </div>
          </div>

          {/* 已解锁成就 */}
          <div>
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-headline text-lg text-white tracking-[0.2em] uppercase">Special Badges</h3>
              <div className="text-[10px] font-mono text-text-dark uppercase bg-light-charcoal px-2 py-1 rounded">
                <span className="text-electric-blue font-bold">{unlockedCount}</span>
                <span> / {ACHIEVEMENTS.length} COLLECTED</span>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-4">
              {ACHIEVEMENTS.map((ach) => (
                <Badge 
                  key={ach.id} 
                  achievement={ach} 
                  status={stats.achievementStatuses.find(s => s.id === ach.id)!} 
                />
              ))}
            </div>
          </div>

        </div>

        {/* 底部操作 */}
        <div className="p-8 bg-light-charcoal/20 border-t border-mid-charcoal">
          <button 
            onClick={onLogout}
            className="w-full h-14 flex items-center justify-center gap-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-2xl transition-all font-bold uppercase tracking-widest text-sm"
          >
            <span className="material-symbols-outlined">logout</span>
            Terminate Session
          </button>
        </div>
      </div>
    </div>
  );
};
