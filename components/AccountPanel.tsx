import React, { useMemo, useEffect, useState } from 'react';
import { DayStats, WordEntry, InputSession } from '../types';
import { calculateAchievements } from '../services/achievementService';
import { HoverTranslationText } from './HoverTranslationText';
import { useT } from '../hooks/useT';
import { AccountPanelHeader } from './AccountPanel/AccountPanelHeader';
import { LearningAnalyticsSection } from './AccountPanel/LearningAnalyticsSection';
import { StatsOverviewSection } from './AccountPanel/StatsOverviewSection';
import { SmartSelectionSection } from './AccountPanel/SmartSelectionSection';
import { AchievementsSection } from './AccountPanel/AchievementsSection';
import { AccountChartTab } from './AccountPanel/types';
import { ProfileEditModal } from './ProfileEditModal';
import { getProfile } from '../services/profileService';
import type { UserProfile } from '../services/profileService';

interface AccountPanelProps {
  user: any;
  words: WordEntry[];
  sessions: InputSession[];
  dailyStats: Record<string, DayStats>;
  persistedUnlocks?: Set<string>;
  onClose: () => void;
  onLogout: () => void;
}

export const AccountPanel: React.FC<AccountPanelProps> = ({ user, words, sessions, dailyStats, persistedUnlocks, onClose, onLogout }) => {
  const t = useT();
  const [activeChartTab, setActiveChartTab] = useState<AccountChartTab>('progress');
  const [aiSelectionEnabled, setAiSelectionEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('vibe_ai_selection') === 'true';
    }
    return false;
  });
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [showProfileEdit, setShowProfileEdit] = useState(false);

  const toggleAiSelection = () => {
    const newState = !aiSelectionEnabled;
    setAiSelectionEnabled(newState);
    localStorage.setItem('vibe_ai_selection', String(newState));
  };

  useEffect(() => {
    // 锁定主页面滚动
    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = 'hidden';
    
    return () => {
      // 恢复主页面滚动
      document.body.style.overflow = originalStyle;
    };
  }, []);

  // Load user profile
  useEffect(() => {
    if (user?.id) {
      getProfile(user.id).then(setProfile);
    }
  }, [user?.id]);

  const stats = useMemo(() => {
    const totalWords = words.length;
    const testedWords = words.filter(w => w.tested);
    const correctWords = words.filter(w => w.correct);
    const coverage = totalWords > 0 ? (testedWords.length / totalWords) * 100 : 0;
    const accuracy = testedWords.length > 0 ? (correctWords.length / testedWords.length) * 100 : 0;
    
    // 获取成就统计（包含 streak 等信息）
    const achievementStatuses = calculateAchievements(words, sessions, Object.values(dailyStats), persistedUnlocks);
    
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
  }, [words, sessions, dailyStats, persistedUnlocks]);

  const unlockedCount = stats.achievementStatuses.filter(s => s.unlocked).length;

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-end">
        {/* 遮罩层 */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={onClose}></div>

        {/* 面板主内容 */}
        <div className="relative h-full w-full max-w-md bg-dark-charcoal border-l border-mid-charcoal shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
          <AccountPanelHeader
            email={user?.email}
            username={profile?.username}
            avatarUrl={profile?.avatar_url}
            onClose={onClose}
            onEditProfile={() => setShowProfileEdit(true)}
          />

          {/* 滚动内容区 */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-8 space-y-10 custom-scrollbar">
            <LearningAnalyticsSection
              words={words}
              activeChartTab={activeChartTab}
              onTabChange={setActiveChartTab}
            />
            <StatsOverviewSection stats={stats} />
            <SmartSelectionSection enabled={aiSelectionEnabled} onToggle={toggleAiSelection} />
            <AchievementsSection
              unlockedCount={unlockedCount}
              achievementStatuses={stats.achievementStatuses}
            />
          </div>

          {/* 底部操作 */}
          <div className="p-8 bg-light-charcoal/20 border-t border-mid-charcoal">
            <button
              onClick={onLogout}
              className="w-full h-14 flex items-center justify-center gap-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-2xl transition-all font-bold uppercase tracking-widest text-sm"
            >
              <span className="material-symbols-outlined">logout</span>
              {t.terminateSession}
            </button>
          </div>
        </div>
      </div>

      {/* Profile edit modal (z-[200] — sits above the panel) */}
      {showProfileEdit && user?.id && (
        <ProfileEditModal
          userId={user.id}
          profile={profile}
          onClose={() => setShowProfileEdit(false)}
          onSaved={(updated: UserProfile) => {
            setProfile(updated);
            setShowProfileEdit(false);
          }}
        />
      )}
    </>
  );
};
