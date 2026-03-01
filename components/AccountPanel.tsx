import React, { useMemo, useEffect, useState, useRef } from 'react';
import { WordEntry, InputSession } from '../types';
import { calculateAchievements, ACHIEVEMENTS } from '../services/achievementService';
import { Badge } from './Achievements/Badge';
import { supabase } from '../lib/supabaseClient';
import { AISettings, AEServiceProvider } from '../services/ai/settings';
import { ProgressPieChart, MasteryPieChart } from './Charts';
import { adminService } from '../services/adminService';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';
import { ToggleSwitch } from './ToggleSwitch';

interface AccountPanelProps {
  user: any;
  words: WordEntry[];
  sessions: InputSession[];
  onClose: () => void;
  onLogout: () => void;
}

export const AccountPanel: React.FC<AccountPanelProps> = ({ user, words, sessions, onClose, onLogout }) => {
  const [activeChartTab, setActiveChartTab] = useState<'progress' | 'mastery'>('progress');
  const [isReplacingPronunciation, setIsReplacingPronunciation] = useState(false);
  const [replaceSwitchOn, setReplaceSwitchOn] = useState(false);
  const [minimaxConnected, setMinimaxConnected] = useState<boolean | null>(null);
  const [replaceRunId, setReplaceRunId] = useState<string | null>(null);
  const [replaceProgress, setReplaceProgress] = useState<{ status: string; total: number; done: number; generated: number; skipped: number; failed: number; message?: string } | null>(null);
  const [isPurgingMinimax, setIsPurgingMinimax] = useState(false);
  const [isDispatchingReplacement, setIsDispatchingReplacement] = useState(false);
  const replaceSwitchRef = useRef(false);
  const replacementLoopRef = useRef(false);
  const replaceRetryingRef = useRef(false);
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

  const isSuperAdmin = (user?.email || '').toLowerCase() === WORD_LEARNING_CONFIG.pronunciation.superAdminEmail.toLowerCase();

  useEffect(() => {
    replaceSwitchRef.current = replaceSwitchOn;
  }, [replaceSwitchOn]);

  useEffect(() => {
    let timer: any = null;
    if (!replaceRunId || !replaceSwitchOn) return;

    const poll = async () => {
      const { data } = await supabase
        .from('pronunciation_rebuild_runs')
        .select('status,total,done,generated,skipped,failed,message,updated_at')
        .eq('run_id', replaceRunId)
        .maybeSingle();

      if (data) {
        setReplaceProgress(prev => ({
          status: data.status,
          total: Math.max(prev?.total || 0, data.total || 0),
          done: Math.max(prev?.done || 0, data.done || 0),
          generated: Math.max(prev?.generated || 0, data.generated || 0),
          skipped: Math.max(prev?.skipped || 0, data.skipped || 0),
          failed: Math.max(prev?.failed || 0, data.failed || 0),
          message: data.message || ''
        }));

        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          setIsReplacingPronunciation(false);
          setIsDispatchingReplacement(false);
          setReplaceSwitchOn(false);
          replaceSwitchRef.current = false;
          return;
        }

        const updatedAtMs = data.updated_at ? Date.parse(data.updated_at) : 0;
        const staleMs = updatedAtMs > 0 ? Date.now() - updatedAtMs : 0;
        if (data.status === 'running' && staleMs > 25000 && !replaceRetryingRef.current && replaceSwitchRef.current) {
          replaceRetryingRef.current = true;
          setReplaceProgress(prev => prev ? { ...prev, message: 'Task heartbeat stale, retrying trigger...' } : prev);
          void adminService.replaceAllPronunciations(() => {}, replaceRunId)
            .catch((error: any) => {
              setReplaceProgress(prev => prev ? {
                ...prev,
                message: `Retry trigger failed: ${error?.message || 'unknown error'}`
              } : prev);
            })
            .finally(() => {
              replaceRetryingRef.current = false;
            });
        }

      }
      timer = setTimeout(poll, 1200);
    };

    poll();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [replaceRunId, replaceSwitchOn]);

  const checkMinimaxConnectivity = async (): Promise<boolean> => {
    try {
      // process.env.SUPABASE_URL is statically replaced by vite.config.ts `define` at build time.
      const supabaseUrl = process.env.SUPABASE_URL
        || (supabase as any)?.supabaseUrl
        || (supabase as any)?.url
        || '';
      if (!supabaseUrl) return false;
      const resp = await fetch(`${supabaseUrl}/functions/v1/pronunciation?word=apple&lang=en&uniqueness_mode=${WORD_LEARNING_CONFIG.pronunciation.uniquenessMode}`);
      return resp.ok;
    } catch {
      return false;
    }
  };

  const startGlobalPronunciationReplacement = async () => {
    if (replacementLoopRef.current) return;
    replacementLoopRef.current = true;
    setIsReplacingPronunciation(true);
    setIsDispatchingReplacement(true);
    setReplaceProgress({ status: 'running', total: 0, done: 0, generated: 0, skipped: 0, failed: 0, message: 'Starting...' });

    const connected = await checkMinimaxConnectivity();
    setMinimaxConnected(connected);

    if (!connected) {
      setReplaceProgress({ status: 'failed', total: 0, done: 0, generated: 0, skipped: 0, failed: 0, message: 'Minimax API unreachable' });
      setIsReplacingPronunciation(false);
      setIsDispatchingReplacement(false);
      setReplaceSwitchOn(false);
      replaceSwitchRef.current = false;
      replacementLoopRef.current = false;
      return;
    }

    const runId = crypto.randomUUID();
    setReplaceRunId(runId);

    try {
      setReplaceProgress(prev => ({
        status: 'running',
        total: prev?.total || 0,
        done: prev?.done || 0,
        generated: prev?.generated || 0,
        skipped: prev?.skipped || 0,
        failed: prev?.failed || 0,
        message: 'Triggering replacement job...'
      }));

      void adminService.replaceAllPronunciations(() => {}, runId)
        .then(() => {
          setReplaceProgress(prev => prev ? { ...prev, message: 'Replacement trigger accepted. Polling progress...' } : prev);
        })
        .catch((error: any) => {
          const message = error?.message || 'Failed to start task';
          const authOrPermissionError = /permission denied|authentication|401|token/i.test(message);
          setReplaceProgress(prev => ({
            status: authOrPermissionError ? 'failed' : (prev?.status || 'running'),
            total: prev?.total || 0,
            done: prev?.done || 0,
            generated: prev?.generated || 0,
            skipped: prev?.skipped || 0,
            failed: prev?.failed || 0,
            message: authOrPermissionError ? message : `Trigger timeout/network issue, continue polling: ${message}`
          }));
          if (authOrPermissionError) {
            setIsReplacingPronunciation(false);
            setReplaceSwitchOn(false);
            replaceSwitchRef.current = false;
          }
        })
        .finally(() => {
          setIsDispatchingReplacement(false);
        });
    } catch (error: any) {
      const message = error?.message || 'Failed to start task';
      setReplaceProgress(prev => ({
        status: 'failed',
        total: prev?.total || 0,
        done: prev?.done || 0,
        generated: prev?.generated || 0,
        skipped: prev?.skipped || 0,
        failed: prev?.failed || 0,
        message
      }));
      setIsReplacingPronunciation(false);
      setIsDispatchingReplacement(false);
      setReplaceSwitchOn(false);
      replaceSwitchRef.current = false;
    } finally {
      replacementLoopRef.current = false;
    }
  };

  const forceRegenerateAllPronunciations = async () => {
    if (!replaceSwitchRef.current || replacementLoopRef.current || isPurgingMinimax) return;

    replacementLoopRef.current = true;
    setIsDispatchingReplacement(true);

    if (isReplacingPronunciation && replaceRunId) {
      setReplaceProgress(prev => ({
        status: 'running',
        total: prev?.total || 0,
        done: prev?.done || 0,
        generated: prev?.generated || 0,
        skipped: prev?.skipped || 0,
        failed: prev?.failed || 0,
        message: 'Stopping current run before force-regenerate...'
      }));
      await adminService.stopPronunciationReplacement(replaceRunId);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    setIsReplacingPronunciation(true);
    const runId = crypto.randomUUID();
    setReplaceRunId(runId);
    setReplaceProgress(prev => ({
      status: 'running',
      total: prev?.total || 0,
      done: prev?.done || 0,
      generated: prev?.generated || 0,
      skipped: prev?.skipped || 0,
      failed: prev?.failed || 0,
      message: 'Force regenerating all words with current voice...'
    }));

    try {
      void adminService.replaceAllPronunciations(() => {}, runId, { forceRegenerate: true })
        .then(() => {
          setReplaceProgress(prev => prev ? { ...prev, message: 'Force-regenerate trigger accepted. Polling progress...' } : prev);
        })
        .catch((error: any) => {
          setReplaceProgress(prev => ({
            status: prev?.status || 'running',
            total: prev?.total || 0,
            done: prev?.done || 0,
            generated: prev?.generated || 0,
            skipped: prev?.skipped || 0,
            failed: prev?.failed || 0,
            message: `Trigger timeout/network issue, continue polling: ${error?.message || 'unknown error'}`
          }));
        })
        .finally(() => {
          setIsDispatchingReplacement(false);
        });
    } catch (error: any) {
      setReplaceProgress(prev => ({
        status: 'failed',
        total: prev?.total || 0,
        done: prev?.done || 0,
        generated: prev?.generated || 0,
        skipped: prev?.skipped || 0,
        failed: prev?.failed || 0,
        message: error?.message || 'Force regeneration failed'
      }));
      setIsReplacingPronunciation(false);
      setIsDispatchingReplacement(false);
    } finally {
      replacementLoopRef.current = false;
    }
  };

  const purgeAllMinimaxAssets = async () => {
    if (!replaceSwitchRef.current || isPurgingMinimax || replacementLoopRef.current) return;

    if (isReplacingPronunciation && replaceRunId) {
      setReplaceProgress(prev => ({
        status: 'running',
        total: prev?.total || 0,
        done: prev?.done || 0,
        generated: prev?.generated || 0,
        skipped: prev?.skipped || 0,
        failed: prev?.failed || 0,
        message: 'Stopping current run before deleting audio...'
      }));
      await adminService.stopPronunciationReplacement(replaceRunId);
      await new Promise(resolve => setTimeout(resolve, 1200));
      setIsReplacingPronunciation(false);
      setIsDispatchingReplacement(false);
    }

    setIsPurgingMinimax(true);
    setReplaceProgress(prev => ({
      status: 'running',
      total: prev?.total || 0,
      done: prev?.done || 0,
      generated: prev?.generated || 0,
      skipped: prev?.skipped || 0,
      failed: prev?.failed || 0,
      message: 'Deleting all Minimax audio assets...'
    }));

    try {
      const result = await adminService.purgeAllMinimaxPronunciations(() => {});
      setReplaceProgress({
        status: 'completed',
        total: 0,
        done: 0,
        generated: 0,
        skipped: 0,
        failed: 0,
        message: `Deleted Minimax assets=${result.deletedAssets}, storage=${result.deletedStorageObjects}`
      });
    } catch (error: any) {
      setReplaceProgress(prev => ({
        status: 'failed',
        total: prev?.total || 0,
        done: prev?.done || 0,
        generated: prev?.generated || 0,
        skipped: prev?.skipped || 0,
        failed: prev?.failed || 0,
        message: error?.message || 'Purge failed'
      }));
    } finally {
      setIsPurgingMinimax(false);
    }
  };

  const onToggleReplacementSwitch = async () => {
    const next = !replaceSwitchOn;
    setReplaceSwitchOn(next);
    replaceSwitchRef.current = next;

    if (next) {
      void startGlobalPronunciationReplacement();
    } else {
      if (replaceRunId) {
        void adminService.stopPronunciationReplacement(replaceRunId);
      }
      setIsReplacingPronunciation(false);
      setReplaceProgress(prev => prev ? { ...prev, status: 'cancelled', message: 'Stopped by admin' } : prev);
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

          {/* 学习进度可视化 */}
          <div className="space-y-4">
            <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">Learning Analytics</h3>

            {/* 标签切换 */}
            <div className="flex gap-2 bg-dark-charcoal p-1.5 rounded-2xl border border-mid-charcoal/30">
              <button
                onClick={() => setActiveChartTab('progress')}
                className={`flex-1 py-2.5 px-4 rounded-xl font-mono text-xs uppercase tracking-wider transition-all duration-300 ${
                  activeChartTab === 'progress'
                    ? 'bg-electric-blue text-white shadow-[0_0_15px_rgba(59,130,246,0.4)]'
                    : 'text-text-dark hover:text-white'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-sm">analytics</span>
                  Test Coverage
                </span>
              </button>
              <button
                onClick={() => setActiveChartTab('mastery')}
                className={`flex-1 py-2.5 px-4 rounded-xl font-mono text-xs uppercase tracking-wider transition-all duration-300 ${
                  activeChartTab === 'mastery'
                    ? 'bg-electric-green text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]'
                    : 'text-text-dark hover:text-white'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-sm">school</span>
                  Mastery Level
                </span>
              </button>
            </div>

            {/* 饼状图展示区域 */}
            <div className="bg-light-charcoal/30 p-6 rounded-3xl border border-mid-charcoal/50">
              {activeChartTab === 'progress' ? (
                <div className="flex flex-col items-center">
                  <div className="text-center mb-4">
                    <p className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-1">
                      Vocabulary Coverage
                    </p>
                    <p className="text-xs text-text-light leading-relaxed">
                      Track your progress through the entire word library
                    </p>
                  </div>
                  <ProgressPieChart words={words} />
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <div className="text-center mb-4">
                    <p className="text-[10px] text-text-dark font-mono uppercase tracking-widest mb-1">
                      Word Mastery Distribution
                    </p>
                    <p className="text-xs text-text-light leading-relaxed">
                      See how many words you've mastered vs still learning
                    </p>
                  </div>
                  <MasteryPieChart words={words} />
                </div>
              )}
            </div>
          </div>

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

          {/* Smart Selection Settings */}
          <div className="space-y-4">
             <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">Smart Selection</h3>
             <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30 flex items-center justify-between">
                <div>
                    <div className="text-white font-mono text-sm mb-1">Smart Selection Assistant</div>
                    <div className="text-[10px] text-text-light font-mono max-w-[200px] leading-tight">
                        OFF: Random selection from checked words<br/>
                        ON: Intelligent selection based on error history & forgetting curve
                    </div>
                </div>
                <ToggleSwitch
                  checked={aiSelectionEnabled}
                  onChange={toggleAiSelection}
                  ariaLabel="Toggle smart selection"
                />
             </div>
          </div>

          {isSuperAdmin && WORD_LEARNING_CONFIG.pronunciation.enableManualBatchReplacement && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">Global Pronunciation</h3>
              </div>
              <div className="bg-light-charcoal/30 p-6 rounded-3xl border border-mid-charcoal/50">
                <p className="text-xs text-text-dark font-mono leading-relaxed mb-6">
                  Admin-only global scan across ALL users. Dedup first, then generate missing pronunciation with Minimax only.
                </p>

                <div className="bg-dark-charcoal/80 p-4 rounded-2xl border border-electric-blue/30 mb-6">
                  <h4 className="text-[10px] font-mono text-electric-blue uppercase tracking-widest mb-3">Runtime Status</h4>
                  <div className="grid grid-cols-2 gap-y-3">
                    <div className="text-white font-mono text-xs">Minimax API:</div>
                    <div className={`font-mono text-xs font-bold text-right ${minimaxConnected === true ? 'text-electric-green' : minimaxConnected === false ? 'text-red-400' : 'text-text-dark'}`}>
                      {minimaxConnected === true ? 'CONNECTED' : minimaxConnected === false ? 'FAILED' : 'UNKNOWN'}
                    </div>
                    <div className="text-white font-mono text-xs">Mode:</div>
                    <div className="text-electric-blue font-mono text-xs font-bold text-right uppercase">{WORD_LEARNING_CONFIG.pronunciation.uniquenessMode}</div>
                    <div className="text-white font-mono text-xs">RPM Limit:</div>
                    <div className="text-yellow-400 font-mono text-xs font-bold text-right">{WORD_LEARNING_CONFIG.pronunciation.maxRequestsPerMinute}</div>
                    <div className="text-white font-mono text-xs">Progress:</div>
                    <div className="text-text-dark font-mono text-xs text-right">{replaceProgress ? `${replaceProgress.done}/${replaceProgress.total}` : '0/0'}</div>
                    <div className="text-white font-mono text-xs">Generated:</div>
                    <div className="text-electric-green font-mono text-xs font-bold text-right">{replaceProgress?.generated || 0}</div>
                    <div className="text-white font-mono text-xs">Skipped (Dedup):</div>
                    <div className="text-electric-blue font-mono text-xs font-bold text-right">{replaceProgress?.skipped || 0}</div>
                    <div className="text-white font-mono text-xs">Failed:</div>
                    <div className="text-red-400 font-mono text-xs font-bold text-right">{replaceProgress?.failed || 0}</div>
                  </div>
                  {replaceProgress?.message && (
                    <p className="mt-3 text-[10px] text-text-dark font-mono">{replaceProgress.message}</p>
                  )}
                </div>

                <div className="flex items-center justify-between bg-dark-charcoal/80 p-4 rounded-2xl border border-mid-charcoal/50">
                  <div>
                    <div className="text-white font-mono text-sm mb-1">Vocabulary Audio Manager</div>
                    <div className="text-[10px] text-text-light font-mono">Turn on to start immediate full-scan and generation</div>
                  </div>
                  <ToggleSwitch
                    checked={replaceSwitchOn}
                    onChange={onToggleReplacementSwitch}
                    ariaLabel="Toggle vocabulary audio manager"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 mt-3">
                  <button
                    onClick={purgeAllMinimaxAssets}
                    disabled={!replaceSwitchOn || isPurgingMinimax}
                    className={`h-10 rounded-xl font-mono text-xs uppercase tracking-wider transition-colors ${!replaceSwitchOn || isPurgingMinimax ? 'bg-mid-charcoal text-text-dark cursor-not-allowed' : 'bg-red-500/10 border border-red-500/40 text-red-400 hover:bg-red-500 hover:text-charcoal'}`}
                  >
                    {isPurgingMinimax ? 'DELETING...' : isReplacingPronunciation ? 'Delete ALL' : 'Delete Audio'}
                  </button>

                  <button
                    onClick={forceRegenerateAllPronunciations}
                    disabled={!replaceSwitchOn || isPurgingMinimax || isDispatchingReplacement}
                    className={`h-10 rounded-xl font-mono text-xs uppercase tracking-wider transition-colors ${!replaceSwitchOn || isPurgingMinimax || isDispatchingReplacement ? 'bg-mid-charcoal text-text-dark cursor-not-allowed' : 'bg-electric-blue/10 border border-electric-blue/40 text-electric-blue hover:bg-electric-blue hover:text-charcoal'}`}
                  >
                    {isDispatchingReplacement ? 'DISPATCHING...' : isReplacingPronunciation ? 'Restart Regenerate' : 'Regenerate All'}
                  </button>
                </div>
                {!replaceSwitchOn && (
                  <p className="mt-2 text-[10px] text-text-dark font-mono">Turn on master switch to enable delete/regenerate actions.</p>
                )}
              </div>
            </div>
          )}
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
