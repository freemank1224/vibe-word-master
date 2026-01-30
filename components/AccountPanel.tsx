import React, { useMemo, useEffect, useState } from 'react';
import { WordEntry, InputSession } from '../types';
import { calculateAchievements, ACHIEVEMENTS } from '../services/achievementService';
import { Badge } from './Achievements/Badge';
import { cleanExistingWords, CleanupStats } from '../services/wordCleanupService';
import { supabase } from '../lib/supabaseClient';

interface AccountPanelProps {
  user: any;
  words: WordEntry[];
  sessions: InputSession[];
  onClose: () => void;
  onLogout: () => void;
}

const IssueRow: React.FC<{ 
    issue: { id: string, text: string }, 
    onFix: (text: string) => void, 
    onDelete: () => void 
}> = ({ issue, onFix, onDelete }) => {
    const [text, setText] = useState(issue.text);
    return (
        <div className="flex gap-2 items-center bg-dark-charcoal p-2 rounded-xl border border-mid-charcoal group">
            <input 
                type="text" 
                value={text} 
                onChange={(e) => setText(e.target.value)}
                className="flex-1 bg-transparent border-none text-white font-mono text-sm focus:ring-0 p-1"
            />
            <button 
                onClick={() => onFix(text)}
                disabled={text === issue.text}
                className="p-1.5 text-electric-green hover:bg-electric-green/10 rounded-lg disabled:opacity-20 transition-all"
                title="Save Fix"
            >
                <span className="material-symbols-outlined text-lg">check</span>
            </button>
            <button 
                onClick={onDelete}
                className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
                title="Remove Word"
            >
                <span className="material-symbols-outlined text-lg">delete</span>
            </button>
        </div>
    );
};

export const AccountPanel: React.FC<AccountPanelProps> = ({ user, words, sessions, onClose, onLogout }) => {
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupStats | null>(null);
  const [aiSelectionEnabled, setAiSelectionEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('vibe_ai_selection') === 'true';
    }
    return false;
  });

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

  const handleCleanup = async () => {
    if (!user?.id || isCleaning) return;
    
    setIsCleaning(true);
    setCleanupResult(null);
    try {
        const result = await cleanExistingWords(user.id);
        setCleanupResult(result);
        // We might want to refresh the data after cleanup
        if (typeof window !== 'undefined') {
            // Ideally we'd call refreshData from App.tsx, but since we're in a modal
            // and don't have that prop, we can just suggest a reload or wait for next mount.
            // For now, let's just show the result.
        }
    } catch (e) {
        alert("Cleanup failed. Check console.");
    } finally {
        setIsCleaning(false);
    }
  };

  const handleFixIssue = async (id: string, newText: string) => {
    if (!newText.trim()) return;
    try {
        // Update text and reset metadata so it's re-fetched correctly
        await supabase.from('words').update({ 
            text: newText.trim(),
            phonetic: null,
            audio_url: null,
            definition_en: null
        }).eq('id', id);
        
        setCleanupResult(prev => prev ? {
            ...prev,
            issues: prev.issues.filter(i => i.id !== id)
        } : null);
    } catch (e) {
        alert("Fix failed.");
    }
  };

  const handleDeleteIssue = async (id: string) => {
    try {
        await supabase.from('words').update({ deleted: true }).eq('id', id);
        setCleanupResult(prev => prev ? {
            ...prev,
            issues: prev.issues.filter(i => i.id !== id)
        } : null);
    } catch (e) {
        alert("Delete failed.");
    }
  };

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

          {/* AI Settings */}
          <div className="space-y-4">
             <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">Neural Interface</h3>
             <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30 flex items-center justify-between">
                <div>
                    <div className="text-white font-mono text-sm mb-1">AI Smart Selection</div>
                    <div className="text-[10px] text-text-light font-mono max-w-[200px] leading-tight">
                        Optimize test words using Ebbinghaus forgetting curve & error history.
                    </div>
                </div>
                <button 
                  onClick={toggleAiSelection}
                  className={`w-14 h-8 rounded-full transition-colors relative ${aiSelectionEnabled ? 'bg-electric-blue' : 'bg-mid-charcoal'}`}
                >
                  <div className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full transition-transform ${aiSelectionEnabled ? 'translate-x-6' : ''}`} />
                </button>
             </div>
          </div>

          {/* Word Library Cleanup Tool */}
          <div className="space-y-4">
             <div className="flex justify-between items-center">
                <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">Library Maintenance</h3>
             </div>
             <div className="bg-light-charcoal/30 p-6 rounded-3xl border border-mid-charcoal/50">
                <p className="text-xs text-text-dark font-mono leading-relaxed mb-6">
                    Scan your vocabulary for spelling errors and remove single-letter invalid entries.
                </p>
                
                {cleanupResult ? (
                    <div className="bg-dark-charcoal/80 p-4 rounded-2xl border border-electric-blue/30 mb-6 animate-in zoom-in-95 duration-300">
                        <h4 className="text-[10px] font-mono text-electric-blue uppercase tracking-widest mb-3">Cleanup Report</h4>
                        <div className="grid grid-cols-2 gap-y-3">
                            <div className="text-white font-mono text-xs">Corrected:</div>
                            <div className="text-electric-green font-mono text-xs font-bold text-right">{cleanupResult.corrected}</div>
                            
                            <div className="text-white font-mono text-xs">Invalid/Removed:</div>
                            <div className="text-red-400 font-mono text-xs font-bold text-right">{cleanupResult.deletedSingleLetter}</div>
                            
                            <div className="text-white font-mono text-xs">Manual Review:</div>
                            <div className="text-yellow-400 font-mono text-xs font-bold text-right">{cleanupResult.issues.length}</div>

                            <div className="text-white font-mono text-xs">Processed:</div>
                            <div className="text-text-dark font-mono text-xs text-right">{cleanupResult.totalProcessed}</div>
                        </div>

                        {cleanupResult.issues.length > 0 && (
                            <div className="mt-6 space-y-3 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                                <p className="text-[10px] text-yellow-500/80 font-mono uppercase">Unresolved Words:</p>
                                {cleanupResult.issues.map(issue => (
                                    <IssueRow 
                                        key={issue.id} 
                                        issue={issue} 
                                        onFix={(text) => handleFixIssue(issue.id, text)} 
                                        onDelete={() => handleDeleteIssue(issue.id)} 
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                ) : null}

                <button 
                    onClick={handleCleanup}
                    disabled={isCleaning}
                    className={`w-full py-4 rounded-2xl font-headline tracking-widest transition-all flex items-center justify-center gap-3
                        ${isCleaning 
                            ? 'bg-mid-charcoal text-gray-500 cursor-not-allowed' 
                            : 'bg-electric-blue/10 border border-electric-blue/30 text-electric-blue hover:bg-electric-blue hover:text-charcoal'}`}
                >
                    <span className={`material-symbols-outlined ${isCleaning ? 'animate-spin' : ''}`}>
                        {isCleaning ? 'sync' : 'auto_fix_high'}
                    </span>
                    {isCleaning ? 'CLEANING MATRIX...' : 'RUN SPELL CHECK'}
                </button>
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
