import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabaseClient';
import { createLazyFeature } from './components/LazyFeature';
import { fetchUserData, fetchUserLearningProgress, invalidateUserDataReads, fetchUserStats, saveSessionData, modifySession, updateWordStatus, getImageUrl, updateWordStatusV2, deleteSessions, deleteWordsByIds, fetchUserAchievements, saveUserAchievement, DeleteProgress, recordPuzzleGameRound, updateWordMetadata, healDoubleEncodedImageUrls } from './services/dataService';
import { resolveStatsUpdate, compareVersions, mergeStats } from './utils/versionMerge';
import { processPendingSyncs, getPendingSyncCount, enqueuePendingSync, hasUnattributedLegacySyncs } from './services/offlineSyncQueue';
import {
  loadLocalBackup,
  saveLocalBackup,
  saveSessionToLocal,
  deleteSessionFromLocal,
  syncSessionToCloud,
  resolveConflict,
  syncAllPendingSessions,
  persistSessionSyncResult,
  SessionWithSync,
  SyncStatus,
  SyncResult
} from './services/syncService';
import { AppMode, ClassicTestConfig, CompletedTestSummary, DayStats, InputSession, PuzzleGameSummary, WordEntry, WordMeaningOption } from './types';
import { LargeWordInput } from './components/LargeWordInput';
import { CalendarView } from './components/CalendarView';
import { Confetti } from './components/Confetti';
import { MeaningFlipCard } from './components/MeaningFlipCard';
import { adaptiveWordSelector } from './services/adaptiveWordSelector';
import { persistLearningAttempt, recordLearningRound, overlayLearningProgress, type LearningResult } from './services/learningRecordStore';
import { syncPendingLearningProgress } from './services/learningProgressSync';
import { posOf } from './utils/wordPartOfSpeech';
import { LeaderboardPanel } from './components/LeaderboardPanel';
import { aiService } from './services/ai';
import { compressToWebP } from './utils/imageUtils';
import { getImageGenerationQueueSnapshot, requestQueuedWordImage } from './services/imageGenerationQueue';
import { fetchSavedDictionaryData, playWordAudio as playWordAudioService, type DictionaryData } from './services/dictionaryService';
import { DEFINITION_BACKFILL_INTERVAL_MS, DEFINITION_BACKFILL_RETRY_MS, isSupabaseRateLimited, withDefinitionBackfillPermit } from './services/definitionBackfillPacing';
import { dictionaryBackfillFilters, missingDictionaryFields, needsDictionaryEnrichment } from './services/testPreparation';
import { playDing, playBuzzer, playAchievementUnlock } from './utils/audioFeedback';
import { cacheGeneratedImageForWord, getCachedImageDataUrl, getCachedImageWordIds } from './services/imageCache';
import { AchievementsPanel } from './components/Achievements/AchievementsPanel';
import { calculateAchievements, ACHIEVEMENTS, Achievement } from './services/achievementService';
import { CoinCounter } from './components/Coin/CoinCounter';
import { subscribeToWalletChanges } from './services/walletUpdates';
import {
  claimDailyLoginReward,
  awardPuzzleCoins,
  awardAchievementCoins,
  awardAllAchievementsBonus,
  getCoinBalance,
  type DailyLoginReward,
} from './services/coinService';
// import { generateImagesForMissingWords } from './services/imageGenerationTask';
import { LandingPage } from './components/LandingPage';
import { HoverTranslationText } from './components/HoverTranslationText';
import { getShanghaiDateString } from './utils/timezone';
import { WORD_LEARNING_CONFIG } from './config/wordLearningConfig';
import { useLanguage } from './contexts/LanguageContext';
import { DailyReviewReminder, ReviewBadge } from './components/DailyReviewReminder';
import { createReviewReminderHistory, shouldShowDailyReviewReminder } from './utils/dailyReviewReminder';
import { useT } from './hooks/useT';
import { wordMeaningForLanguage } from './utils/wordMeaningLocale';
import { normalizeChineseMeaning } from './utils/chineseMeaning';
import GlobalChampionBanner from './components/GlobalChampionBanner';

const Auth = createLazyFeature(() => import('./components/Auth'), '登录');
const PasswordReset = createLazyFeature(() => import('./components/PasswordReset'), '密码重置');
const PasswordForgotRequest = createLazyFeature(() => import('./components/PasswordForgotRequest'), '找回密码');
const WatchaCallback = createLazyFeature(() => import('./components/WatchaCallback'), '账号授权');
const TestModeV2 = createLazyFeature(() => import('./components/TestModeV2'), '普通测验');
const PuzzleGameMode = createLazyFeature(() => import('./components/PuzzleGameMode'), '九宫格游戏');
const AccountPanel = createLazyFeature(() => import('./components/AccountPanel').then(module => ({ default: module.AccountPanel })), '个人中心', true);
const AdminConsole = createLazyFeature(() => import('./components/AdminConsole').then(module => ({ default: module.AdminConsole })), '管理面板', true);
const PronunciationMaintenancePanel = createLazyFeature(() => import('./components/PronunciationMaintenancePanel').then(module => ({ default: module.PronunciationMaintenancePanel })), '发音维护', true);
const LibrarySelector = createLazyFeature(() => import('./components/LibrarySelector').then(module => ({ default: module.LibrarySelector })), '词库选择');
const GlobalLeaderboardModal = createLazyFeature(() => import('./components/GlobalLeaderboardModal'), '全球排行榜', true);
const GameModePickerModal = createLazyFeature(() => import('./components/GameModePickerModal').then(module => ({ default: module.GameModePickerModal })), '游戏模式', true);
const AchievementUnlockModal = createLazyFeature(() => import('./components/Achievements/AchievementUnlockModal').then(module => ({ default: module.AchievementUnlockModal })), '成就奖励', true);
const DailyLoginRewardModal = createLazyFeature(() => import('./components/Coin/DailyLoginRewardModal').then(module => ({ default: module.DailyLoginRewardModal })), '每日奖励', true);
const CoinRewardPopup = createLazyFeature(() => import('./components/Coin/CoinRewardPopup').then(module => ({ default: module.CoinRewardPopup })), '金币奖励', true);

// --- Tooltip Component ---
interface TooltipProps {
    content: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

const Tooltip: React.FC<TooltipProps> = ({ content, children, className = '' }) => {
    const [isVisible, setIsVisible] = useState(false);
    const [position, setPosition] = useState<'top' | 'bottom'>('top');
    const targetRef = useRef<HTMLDivElement>(null);

    const handleMouseEnter = () => {
        if (targetRef.current) {
            const rect = targetRef.current.getBoundingClientRect();
            const spaceTop = rect.top;
            const spaceBottom = window.innerHeight - rect.bottom;
            setPosition(spaceTop > spaceBottom ? 'bottom' : 'top');
        }
        setIsVisible(true);
    };

    return (
        <div
            ref={targetRef}
            className={`relative inline-block ${className}`}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={() => setIsVisible(false)}
        >
            {children}
            {isVisible && (
                <div
                    className={`absolute left-1/2 -translate-x-1/2 w-64 z-[9999] animate-in fade-in zoom-in-95 duration-200 ${
                        position === 'top'
                            ? 'bottom-full mb-2'
                            : 'top-full mt-2'
                    }`}
                >
                    <div className="bg-dark-charcoal border border-mid-charcoal rounded-lg px-3 py-2 shadow-xl">
                                                        <div className={`absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-dark-charcoal border border-mid-charcoal rotate-45 ${
                                                            position === 'top'
                                                                ? 'bottom-full -translate-y-1/2 border-b-0 border-r-0'
                                                                : 'top-full -translate-y-1/2 border-t-0 border-l-0'
                                                        }`}></div>
                                                        <div className="text-xs text-text-light leading-relaxed">
                                                            {content}
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                };

type TestConfig = ClassicTestConfig | { kind: 'PUZZLE' };

type EditableWord = {
  tempId: string;
  id?: string;
  text: string;
  imageBase64?: string;
  hasImage?: boolean;
  imageUrl?: string;
  imageGenerating?: boolean;
  definition_cn?: string;
  definition_en?: string;
  meaning_options?: WordMeaningOption[];
  selected_meaning_key?: string;
  language?: string;
};

type ResolvedDictionaryDetails = {
  definition_cn?: string;
  definition_en?: string;
  meaning_options: WordMeaningOption[];
  selected_meaning_key?: string;
};

type InputValidationStage =
  | 'IDLE'
  | 'VALIDATING_SPELLING'
  | 'VALIDATING_PHRASE'
  | 'CHECKING_COLLOCATION'
  | 'GENERATING_CHINESE_MEANING'
  | 'GENERATING_PRONUNCIATION'
  | 'FINALIZING';

const createEditableWord = (word: Omit<EditableWord, 'tempId'> & { tempId?: string }): EditableWord => ({
  tempId: word.tempId || word.id || globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  id: word.id,
  text: word.text,
  imageBase64: word.imageBase64,
  hasImage: word.hasImage,
  imageUrl: word.imageUrl,
  imageGenerating: word.imageGenerating,
  definition_cn: word.definition_cn,
  definition_en: word.definition_en,
  meaning_options: word.meaning_options,
  selected_meaning_key: word.selected_meaning_key,
  language: word.language || 'en',
});

type ImageGenDebugEntry = {
  ts: string;
  stage: string;
  payload?: any;
};

const IMAGE_GEN_DEBUG_STORAGE_KEY = 'vibe_word_image_gen_debug_logs_v1';

const normalizeDefinitionBackfillKey = (text: string, language: string = 'en') => {
  return `${language.toLowerCase()}:${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
};

// Module-level guard: ensures we only auto-claim the daily reward once per
// login session (prevents double-claim if onAuthStateChange fires repeatedly).
let _lastDailyClaimUserId: string | null = null;

const App: React.FC = () => {
  const t = useT();
  const { isZh, language } = useLanguage();
  const localeRef = useRef(isZh);
  localeRef.current = isZh;
  const copy = useCallback((en: string, zh: string) => localeRef.current ? zh : en, []);
  const [session, setSession] = useState<any>(null);
  const [showLanding, setShowLanding] = useState(true);
  const [mode, setMode] = useState<AppMode>('DASHBOARD');
  const definitionBackfillInFlightRef = useRef<Set<string>>(new Set());
  const definitionBackfillQueueRef = useRef<Map<string, { text: string; language: string; lexemeId?: string | null }>>(new Map());
  const definitionBackfillCompletedRef = useRef<Set<string>>(new Set());
  const definitionBackfillRetryRef = useRef<Map<string, number>>(new Map());
  const definitionBackfillRunningRef = useRef(false);
  const definitionBackfillIdentityRevisionRef = useRef(-1);
  const definitionBackfillEpochRef = useRef(0);
  const definitionBackfillControllerRef = useRef<AbortController | null>(null);
  const latestWordsRef = useRef<WordEntry[]>([]);
  const authUserIdRef = useRef<string | null>(null);
  const refreshRequestRef = useRef(0);

  // 通知系统
  const [notification, setNotification] = useState<{ message: string | { en: string; zh: string }; type: 'success' | 'warning' | 'error' } | null>(null);
  const imageGenDebugRef = useRef<ImageGenDebugEntry[]>([]);

  const showNotification = (message: string | { en: string; zh: string }, type: 'success' | 'warning' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000); // 5秒后自动消失
  };

  const showLocalizedNotification = (en: string, zh: string, type: 'success' | 'warning' | 'error' = 'success') => {
    showNotification({ en, zh }, type);
  };

  const appendImageGenDebug = useCallback((stage: string, payload?: any) => {
    const entry: ImageGenDebugEntry = {
      ts: new Date().toISOString(),
      stage,
      payload,
    };

    imageGenDebugRef.current = [...imageGenDebugRef.current, entry].slice(-300);
    try {
      localStorage.setItem(IMAGE_GEN_DEBUG_STORAGE_KEY, JSON.stringify(imageGenDebugRef.current));
    } catch {
    }

    (window as any).__vibeImageGenDebug = imageGenDebugRef.current;
    console.log('[image-gen-debug]', entry);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(IMAGE_GEN_DEBUG_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        imageGenDebugRef.current = parsed.slice(-300);
      }
    } catch {
      imageGenDebugRef.current = [];
    }

    (window as any).__vibeImageGenDebug = imageGenDebugRef.current;
    (window as any).dumpImageGenDebug = () => {
      const logs = imageGenDebugRef.current;
      console.table(logs.map(item => ({ ts: item.ts, stage: item.stage })));
      console.log('full_logs', logs);
      return logs;
    };
    (window as any).clearImageGenDebug = () => {
      imageGenDebugRef.current = [];
      localStorage.removeItem(IMAGE_GEN_DEBUG_STORAGE_KEY);
      (window as any).__vibeImageGenDebug = [];
      console.log('[image-gen-debug] logs cleared');
    };
  }, []);

  useEffect(() => {
    definitionBackfillInFlightRef.current.clear();
    definitionBackfillQueueRef.current.clear();
    definitionBackfillCompletedRef.current.clear();
    definitionBackfillRetryRef.current.clear();
    definitionBackfillRunningRef.current = false;
  }, [session?.user?.id]);

  useEffect(() => () => {
    definitionBackfillEpochRef.current += 1;
    definitionBackfillControllerRef.current?.abort();
  }, []);

  // 一次性自愈：登录后修复历史多词短语图片被双重编码的 public_url（get up / high heels 等）
  useEffect(() => {
    if (!session?.user?.id) return;
    void healDoubleEncodedImageUrls();
  }, [session?.user?.id]);

  // 同步状态
  const [syncingSessionId, setSyncingSessionId] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);  // ✅ NEW (Phase C): Pending sync queue count
  const [conflictModal, setConflictModal] = useState<{
    sessionId: string;
    cloud: InputSession;
    local: InputSession;
  } | null>(null);
  const [conflictChoice, setConflictChoice] = useState<'cloud' | 'local' | null>(null);
  const [words, setWords] = useState<WordEntry[]>([]);
  const [cachedImageWordIds, setCachedImageWordIds] = useState<Set<string>>(new Set());
  const [cachedImageDataUrls, setCachedImageDataUrls] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<InputSession[]>([]);
  const [dailyStats, setDailyStats] = useState<Record<string, DayStats>>({});
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    latestWordsRef.current = words;
  }, [words]);

  useEffect(() => {
    setCachedImageWordIds(getCachedImageWordIds());
  }, [session?.user?.id, words.length]);

  useEffect(() => {
    let cancelled = false;

    const loadCachedUrls = async () => {
      const targetWords = words.filter(w => !w.image_url && cachedImageWordIds.has(w.id));
      if (targetWords.length === 0) {
        setCachedImageDataUrls(prev => {
          const existingIds = new Set(words.map(w => w.id));
          const next: Record<string, string> = {};
          Object.keys(prev).forEach(id => {
            if (existingIds.has(id)) next[id] = prev[id];
          });
          return next;
        });
        return;
      }

      const pairs = await Promise.all(
        targetWords.map(async (w) => {
          const url = await getCachedImageDataUrl(w.id);
          return [w.id, url] as const;
        })
      );

      if (cancelled) return;

      setCachedImageDataUrls(prev => {
        const next: Record<string, string> = { ...prev };
        for (const [id, url] of pairs) {
          if (url) next[id] = url;
        }
        return next;
      });
    };

    void loadCachedUrls();
    return () => {
      cancelled = true;
    };
  }, [words, cachedImageWordIds]);

  // Edit Mode State
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  
  // Test Mode Configuration State
  const [testConfig, setTestConfig] = useState<TestConfig | null>(null);
  const [showQuickTestModal, setShowQuickTestModal] = useState(false);
  // Monster Surf and Puzzle use a separate picker from the classic test ranges.
  const [showGamePickerModal, setShowGamePickerModal] = useState(false);
  
  // Multi-Select State for Dashboard Testing
  const [selectedDashboardSessionIds, setSelectedDashboardSessionIds] = useState<Set<string>>(new Set());
  const [highlightRecentSessions, setHighlightRecentSessions] = useState(false);

  // Delete Confirmation State
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [idsToDelete, setIdsToDelete] = useState<string[]>([]);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Admin Console State
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [showPronunciationMaintenancePanel, setShowPronunciationMaintenancePanel] = useState(false);

  // Password Reset State
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [showPasswordForgot, setShowPasswordForgot] = useState(false);

  // Watcha OAuth Callback State
  const [isWatchaCallback, setIsWatchaCallback] = useState(false);

  // Check for password reset in URL hash
  useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.includes('type=recovery')) {
      // Extract access_token from hash
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get('access_token');
      if (accessToken) {
        setResetToken(accessToken);
      } else {
        // Some providers/flows may not include access_token immediately
        // but still indicate a password recovery flow.
        setResetToken('recovery');
      }
    }
  }, []);

  // Check for Watcha OAuth callback in URL
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    // Check if this is a Watcha callback (has code and state params)
    if (code && state) {
      setIsWatchaCallback(true);
    }
  }, []);

  useEffect(() => {
    const superAdminEmail = WORD_LEARNING_CONFIG.pronunciation.superAdminEmail.toLowerCase();
    const isSuperAdmin = (session?.user?.email || '').toLowerCase().trim() === superAdminEmail;

    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName.toLowerCase();
      const isEditing = tag === 'input' || tag === 'textarea';

      // Toggle Admin Console with `~` or Backtick
      if ((e.key === '`' || e.key === '~') && !isEditing) {
        if (!isSuperAdmin) {
          showLocalizedNotification(`Only the administrator ${superAdminEmail} can open this panel.`, `仅超级管理员 ${superAdminEmail} 可打开管理面板`, 'warning');
          return;
        }
        setShowAdminConsole(prev => !prev);
      }

      const isPronunciationShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'y';
      if (isPronunciationShortcut && !isEditing) {
        if (!isSuperAdmin) {
          e.preventDefault();
          showLocalizedNotification(`Only the administrator ${superAdminEmail} can open audio maintenance.`, `仅超级管理员 ${superAdminEmail} 可打开音频维护面板`, 'warning');
          return;
        }
        e.preventDefault();
        setShowPronunciationMaintenancePanel(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session?.user?.email]);
  
  // Achievement State
  const [unlockedAchievements, setUnlockedAchievements] = useState<Set<string>>(new Set());
  const [achievementQueue, setAchievementQueue] = useState<Achievement[]>([]);
  const [isReconciled, setIsReconciled] = useState(false);
  const [showAccountPanel, setShowAccountPanel] = useState(false);
  const [showGlobalLeaderboard, setShowGlobalLeaderboard] = useState(false);
  const [hasOpenedGlobalLeaderboard, setHasOpenedGlobalLeaderboard] = useState(false);

  // ─── Coin currency state ─────────────────────────────────────
  // A negative balance represents the wallet RPC loading state.
  const [coinBalance, setCoinBalance] = useState(-1);
  const [dailyLoginReward, setDailyLoginReward] = useState<DailyLoginReward | null>(null);
  const [dailyRewardSettled, setDailyRewardSettled] = useState(false);
  const [loginReviewDay, setLoginReviewDay] = useState(getShanghaiDateString);
  const [reviewReminderOwner, setReviewReminderOwner] = useState<string | null>(null);
  const reviewBadgeRef = useRef<HTMLButtonElement>(null);
  const reviewHistoryRef = useRef(createReviewReminderHistory(() => window.localStorage));
  const [pendingCoinReward, setPendingCoinReward] = useState<{ amount: number; source: 'quiz' | 'puzzle' | 'word_strike' | 'achievement_bonus'; navigateAfter?: boolean } | null>(null);

  // Monotonic sequence guarding setCoinBalance against stale fetches. Each
  // refreshCoinBalance call increments this and only applies its result if it
  // is still the latest call; the daily-login claim bumps it too, so a slow
  // login-time fetch (started before the award committed) can't clobber the
  // authoritative new_balance returned by claimDailyLoginReward.
  const balanceReqSeqRef = useRef(0);
  const authIdentityRevisionRef = useRef(0);
  const loadedDataIdentityRef = useRef<{ userId: string; revision: number } | null>(null);

  const refreshCoinBalance = useCallback(async () => {
    const userId = authUserIdRef.current;
    if (!userId) return;
    const identityRevision = authIdentityRevisionRef.current;
    const seq = ++balanceReqSeqRef.current;
    const bal = await getCoinBalance();
    if (bal !== null && authUserIdRef.current === userId && authIdentityRevisionRef.current === identityRevision
      && seq === balanceReqSeqRef.current) setCoinBalance(bal);
  }, []);

  useEffect(() => subscribeToWalletChanges(() => { void refreshCoinBalance(); }), [refreshCoinBalance]);
  
  // Filtered Data for View (Soft Delete Logic)
  const visibleSessions = useMemo(() => sessions.filter(s => !s.deleted), [sessions]);
  const visibleWords = useMemo(() => words.filter(w => !w.deleted), [words]);
  const [reviewClock, setReviewClock] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setReviewClock(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const dueWords = useMemo(() => adaptiveWordSelector.rankCandidates(visibleWords, reviewClock).filter(item => item.schedule.isDue).map(item => item.word), [visibleWords, reviewClock]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    let cancelled = false;
    let busy = false;
    const sync = async () => {
      if (busy || cancelled || authUserIdRef.current !== userId) return;
      busy = true;
      try {
        await syncPendingLearningProgress(userId);
        // Initial loading owns the full library read. Until it succeeds, only
        // upload pending answers; never launch a second library/media pipeline.
        if (cancelled || authUserIdRef.current !== userId
          || loadedDataIdentityRef.current?.userId !== userId
          || loadedDataIdentityRef.current?.revision !== authIdentityRevisionRef.current
          || document.visibilityState !== 'visible') return;
        const cloudWords = await fetchUserLearningProgress(userId);
        if (cancelled || authUserIdRef.current !== userId) return;
        const byId = new Map(cloudWords.map(word => [word.id, word]));
        const next = overlayLearningProgress(userId, latestWordsRef.current.map(word => {
          const cloud = byId.get(word.id);
          if (!cloud) return word;
          return { ...word, correct: cloud.correct, tested: cloud.tested, score: cloud.score,
            error_count: cloud.error_count, consecutive_correct: cloud.consecutive_correct,
            last_tested: cloud.last_tested, best_time_ms: cloud.best_time_ms,
            review_state: cloud.review_state, learning_revision: cloud.learning_revision };
        }));
        latestWordsRef.current = next; setWords(next);
      } catch (error) { console.warn('[LearningSync] Records retained:', error); }
      finally { busy = false; }
    };
    void sync();
    const syncVisible = () => { if (document.visibilityState === 'visible') void sync(); };
    window.addEventListener('online', syncVisible);
    window.addEventListener('focus', syncVisible);
    document.addEventListener('visibilitychange', syncVisible);
    const timer = window.setInterval(syncVisible, 60000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', syncVisible);
      window.removeEventListener('focus', syncVisible);
      document.removeEventListener('visibilitychange', syncVisible);
      window.clearInterval(timer);
    };
  }, [session?.user?.id]);

  // Auth Listener
  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let alive = true;
    let observedAuthEvent = false;
    const authTimers = new Set<number>();
    const clearAuthTimers = () => {
      authTimers.forEach(timer => window.clearTimeout(timer));
      authTimers.clear();
    };
    const applySession = (nextSession: any) => {
      if (!alive) return;
      const nextUserId = nextSession?.user?.id || null;
      if (authUserIdRef.current !== nextUserId) {
        definitionBackfillControllerRef.current?.abort();
        invalidateUserDataReads();
        authUserIdRef.current = nextUserId;
        refreshRequestRef.current++;
        authIdentityRevisionRef.current++;
        balanceReqSeqRef.current++;
        clearAuthTimers();
        _lastDailyClaimUserId = null;
        setCoinBalance(-1); setPendingCoinReward(null); setDailyLoginReward(null);
        setDailyRewardSettled(false); setReviewReminderOwner(null); setLoginReviewDay(getShanghaiDateString());
        setConflictModal(null); setConflictChoice(null); setSyncingSessionId(null); setPendingSyncCount(0);
        setEditingSessionId(null); setTestConfig(null); setShowQuickTestModal(false); setShowGamePickerModal(false);
        setShowDeleteConfirm(false); setIdsToDelete([]); setDeleteProgress(null); setIsDeleting(false);
        setSelectedDashboardSessionIds(new Set()); setHighlightRecentSessions(false);
        setUnlockedAchievements(new Set()); setAchievementQueue([]); setIsReconciled(false);
        setShowAccountPanel(false); setShowGlobalLeaderboard(false); setHasOpenedGlobalLeaderboard(false);
        setShowAdminConsole(false); setShowPronunciationMaintenancePanel(false);
        setCachedImageWordIds(new Set()); setCachedImageDataUrls({}); setDataError(null);
        latestWordsRef.current = [];
        setWords([]); setSessions([]); setDailyStats({}); setMode('DASHBOARD');
      }
      setSession(nextSession);
      // ─── Daily login reward ────────────────────────────────────
      // Fire once per active account period. The RPC itself is idempotent
      // (same-day re-claim returns already_claimed_today=true), but we
      // also guard client-side to avoid unnecessary network calls and
      // repeated modal pops during auth event flurries.
      if (nextSession?.user?.id && nextSession.user.id !== _lastDailyClaimUserId) {
        const userId = nextSession.user.id;
        const identityRevision = authIdentityRevisionRef.current;
        _lastDailyClaimUserId = userId;
        const isCurrent = () => alive && authUserIdRef.current === userId
          && authIdentityRevisionRef.current === identityRevision;
        // Delay slightly so the initial data fetch kicks off first.
        const timer = window.setTimeout(async () => {
          authTimers.delete(timer);
          if (!isCurrent()) return;
          try {
            const reward = await claimDailyLoginReward();
            if (!isCurrent() || !reward) return;
            setCoinBalance(reward.new_balance);
            balanceReqSeqRef.current += 1;
            if (!reward.already_claimed_today && reward.total_awarded > 0) setDailyLoginReward(reward);
          } catch (error) {
            if (isCurrent()) console.warn('[Wallet] Daily reward request failed:', error);
          } finally {
            if (isCurrent()) setDailyRewardSettled(true);
          }
        }, 800);
        authTimers.add(timer);
      }

    };
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!observedAuthEvent) applySession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      observedAuthEvent = true;
      applySession(session);

      // Check if user's email is confirmed after login/signup
      if (session?.user && !session.user.email_confirmed_at) {
        // Only show this warning if we haven't already shown it for this user
        const notificationKey = `email-warning-shown-${session.user.id}`;
        if (!localStorage.getItem(notificationKey)) {
          const userId = session.user.id;
          const identityRevision = authIdentityRevisionRef.current;
          const timer = window.setTimeout(() => {
            authTimers.delete(timer);
            if (!alive || authUserIdRef.current !== userId || authIdentityRevisionRef.current !== identityRevision) return;
            showLocalizedNotification("Please confirm your email address. Check your inbox and spam folder to activate your account.", "请验证邮箱以激活账号，并检查收件箱和垃圾邮件文件夹。", 'warning');
          }, 1000);
          authTimers.add(timer);
          localStorage.setItem(notificationKey, 'true');
        }
      }
    });

    return () => { alive = false; clearAuthTimers(); subscription.unsubscribe(); };
  }, []);

  // Only an account identity change initializes data. TOKEN_REFRESHED replaces
  // the session object too, but must not restart requests or interrupt a test.
  const dataUserId = session?.user?.id ?? null;
  const dataIdentityRevision = authIdentityRevisionRef.current;
  const refreshData = useCallback(() => {
    const userId = dataUserId;
    const identityRevision = dataIdentityRevision;
    if (userId && authUserIdRef.current === userId && authIdentityRevisionRef.current === identityRevision) {
      const requestId = ++refreshRequestRef.current;
      const isCurrent = () => authUserIdRef.current === userId
        && authIdentityRevisionRef.current === identityRevision && refreshRequestRef.current === requestId;
      const initialLoad = loadedDataIdentityRef.current?.userId !== userId
        || loadedDataIdentityRef.current?.revision !== identityRevision;
      setLoadingData(true);
      setDataError(null);
      // Coin balance loads in parallel (non-blocking; errors are swallowed
      // inside refreshCoinBalance so a wallet RPC failure can't break data load).
      void refreshCoinBalance();
      Promise.all([
          fetchUserData(userId),
          fetchUserStats(userId),
          fetchUserAchievements(userId)
      ])
        .then(([{ sessions, words }, stats, achievementIds]) => {
          if (!isCurrent()) return;
          setSessions(sessions);
          const currentWords = overlayLearningProgress(userId, words);
          latestWordsRef.current = currentWords;
          setWords(currentWords);

          // Initialize Achievements (DB Load)
          setUnlockedAchievements(new Set(achievementIds));

          // ─── One-time achievement coin backfill for existing users ────
          // Users who unlocked achievements BEFORE the coin system shipped
          // never received coins for them. The award RPCs are idempotent
          // (reference=achievement_id), so this is safe to run once and
          // never again.
          const backfillKey = `vibe_coin_ach_backfill_${userId}`;
          if (achievementIds.length > 0 && !localStorage.getItem(backfillKey)) {
            localStorage.setItem(backfillKey, '1');
            achievementIds.forEach(id => {
              void awardAchievementCoins(id).then(a => { if (a > 0) void refreshCoinBalance(); });
            });
            if (achievementIds.length >= 10) {
              void awardAllAchievementsBonus().then(b => { if (b > 0) void refreshCoinBalance(); });
            }
          }

          // ✅ Phase E: Version-aware stats merging with conflict detection
          const shanghaiToday = getShanghaiDateString();

          // First, map server stats to basic format
          const serverStatsMap: Record<string, DayStats> = {};
          stats.forEach((s: any) => {
              serverStatsMap[s.date] = {
                  date: s.date,
                  total: s.total_count || s.total,
                  correct: s.correct_count || s.correct,
                  points: s.total_points ?? s.points ?? 0,
                  is_frozen: s.is_frozen || s.date < shanghaiToday,
                  version: s.version,
                  updated_at: s.updated_at
              };
          });

          // Merge with local stats using version-aware logic
          setDailyStats(current => resolveStatsUpdate(current, Object.values(serverStatsMap)));
          loadedDataIdentityRef.current = { userId, revision: identityRevision };
        })
        .catch((err) => {
            if (!isCurrent()) return;
            console.error("Data load error:", err);
            if (initialLoad) setDataError(copy("Failed to fetch data from the cloud. Please check your connection.", "无法读取云端数据，请检查网络连接。"));
            else showLocalizedNotification("Cloud refresh is incomplete. Your current data is safe; please try again later.", "云端刷新暂未完成，当前数据已保留，请稍后重试。", 'warning');
        })
        .finally(() => { if (isCurrent()) setLoadingData(false); });
    }
  }, [dataUserId, dataIdentityRevision, refreshCoinBalance]);

  useEffect(() => {
      refreshData();
  }, [refreshData]);

  // One account-scoped worker for login, reconnection, focus and periodic retries.
  const flushStatsQueue = useCallback(async (userId: string) => {
    try {
      const result = await processPendingSyncs(userId);
      if (authUserIdRef.current !== userId) return;
      setPendingSyncCount(result.pending);
      if (result.success > 0) {
        const rows = await fetchUserStats(userId);
        if (authUserIdRef.current !== userId) return;
        setDailyStats(prev => resolveStatsUpdate(prev, rows.map(row => ({
          date: row.date, total: row.total_count ?? row.total ?? 0,
          correct: row.correct_count ?? row.correct ?? 0, points: row.total_points ?? row.points ?? 0,
          version: row.version, updated_at: row.updated_at, is_frozen: row.is_frozen,
        }))));
        void refreshCoinBalance();
        const coins = result.receipts.reduce((sum, receipt) => sum + receipt.coins_awarded, 0);
        if (coins > 0) setPendingCoinReward({ amount: coins, source: 'quiz' });
      }
      if (result.failed > 0) showLocalizedNotification("Your test records are saved on this device. Sync will retry automatically.", "测试记录仍保存在本机，将自动重试同步。", 'warning');
    } catch (error) {
      if (authUserIdRef.current !== userId) return;
      console.error('[StatsSync]', error);
      showLocalizedNotification("Statistics sync is incomplete. Your local records are safe.", "统计同步暂未完成，本机记录已保留。", 'warning');
    }
  }, [refreshCoinBalance]);

  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) { setPendingSyncCount(0); return; }
    try {
      setPendingSyncCount(getPendingSyncCount(userId));
      if (hasUnattributedLegacySyncs()) showLocalizedNotification("Older offline records have no account owner. They are retained on this device for now.", "检测到旧版离线记录缺少账号归属，已保留，暂不自动上传。", 'warning');
    } catch (error) {
      console.error('[StatsSync] Local queue could not be read:', error);
      showLocalizedNotification("Offline records could not be read. Please keep your browser data.", "本机离线记录读取异常，请保留浏览器数据。", 'error');
    }
    const sync = () => { void flushStatsQueue(userId); };
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('focus', sync);
    const timer = window.setInterval(sync, 60000);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('focus', sync); window.clearInterval(timer); };
  }, [session?.user?.id, flushStatsQueue]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setWords([]);
    setSessions([]);
    setDailyStats({});
    setUnlockedAchievements(new Set());
    setAchievementQueue([]);
    setCoinBalance(-1);
    setDailyLoginReward(null);
    setPendingCoinReward(null);
    _lastDailyClaimUserId = null;
  };

  // Background Task: Auto-generate images for words missing them
  useEffect(() => {
    if (!session?.user?.id) return;

    const runTask = () => {
      // Run the generation task. This is async but we don't await it here as it runs in background.
      // generateImagesForMissingWords(session.user.id, (wordId, imagePath) => {
      //   // Optimistically update local state so user sees images appear in real-time
      //   setWords(prevWords => prevWords.map(w => {
      //     if (w.id === wordId) {
      //       return { ...w, image_path: imagePath, image_url: getImageUrl(imagePath) };
      //     }
      //     return w;
      //   }));
      // }).catch(err => {
      //   console.error("Background image generation task failed", err);
      // });
    };

    // Initial check after 10 seconds to allow initial load to settle
    const initialTimer = setTimeout(runTask, 10000);

    // Then check periodically (e.g. every 5 minutes)
    const intervalTimer = setInterval(runTask, 5 * 60 * 1000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [session?.user?.id]);


  // Achievement Reconciliation (Phase 1: Silent Sync on Load)
  useEffect(() => {
    // Only run this once when data is loaded and we haven't reconciled yet
    if (loadingData || isReconciled || !dataUserId
      || loadedDataIdentityRef.current?.userId !== dataUserId
      || loadedDataIdentityRef.current?.revision !== dataIdentityRevision) return;

    // We also need to make sure we actually have loaded data. 
    // If sessions/words are empty but loadingData is false, it might mean empty account OR failed load.
    // But assuming successful empty load is fine, reconciliation is fast.
    
    // NOTE: This runs even if sessions/words are emptySets, which is correct (clears nothing, adds nothing).

    const currentCalculated = calculateAchievements(words, sessions, Object.values(dailyStats));
    const missingInDb: string[] = [];
    const newUnlockedSet = new Set(unlockedAchievements);

    currentCalculated.forEach(status => {
        // If logic says unlocked, but State/DB doesn't know about it
        if (status.unlocked && !unlockedAchievements.has(status.id)) {
            missingInDb.push(status.id);
            newUnlockedSet.add(status.id);
        }
    });

    if (missingInDb.length > 0) {
        console.log("Phase 1: Reconciling missing achievements (silent sync):", missingInDb);

        // 1. Update local state immediately so Phase 2 doesn't see them as "new" events
        setUnlockedAchievements(newUnlockedSet);

        // 2. Sync to DB silently (fire and forget)
        if (session?.user?.id) {
            console.log("Phase 1: Saving to DB for user:", session.user.id);
            missingInDb.forEach(id => {
                saveUserAchievement(session.user.id, id).then(() => console.log(`Saved achievement ${id}`));
                // Backfill coins for already-unlocked achievements (idempotent RPC).
                void awardAchievementCoins(id).then(a => { if (a > 0) void refreshCoinBalance(); });
            });

            // If reconciliation pushed the count to 10, claim the all-achievements bonus.
            if (newUnlockedSet.size >= 10) {
              void awardAllAchievementsBonus().then(b => { if (b > 0) void refreshCoinBalance(); });
            }
        } else {
            console.error("Phase 1: Cannot save, no user session");
        }
    }

    // Mark as reconciled so we can start listening for REAL new events
    setIsReconciled(true);
    
  }, [loadingData, isReconciled, words, sessions, dailyStats, unlockedAchievements, session]);


  // Achievement Tracking (Phase 2: Live Events)
  useEffect(() => {
    // Block until reconciliation is complete to avoid "double-counting" historical achievements
    if (loadingData || !isReconciled) return;

    const currentStatuses = calculateAchievements(words, sessions, Object.values(dailyStats));

    // Track how many NEW achievements unlock in this pass so we can detect
    // the 9→10 transition for the all-achievements bonus.
    const prevCount = unlockedAchievements.size;
    let newlyUnlocked = 0;

    // Check for NEW unlocks only (compare with what we already have in state)
    // Since we are Reconciled, any difference here is a GENUINE new event.
    currentStatuses.forEach(status => {
        if (status.unlocked && !unlockedAchievements.has(status.id)) {
            const ach = ACHIEVEMENTS.find(a => a.id === status.id);
            if (ach) {
                newlyUnlocked++;
                // 1. Add to queue (Celebration!)
                setAchievementQueue(prev => [...prev, ach]);
                playAchievementUnlock();

                // 2. Update local state
                setUnlockedAchievements(prev => {
                    const next = new Set(prev);
                    next.add(status.id);
                    return next;
                });

                // 3. Persist to DB + award coins
                if (session?.user?.id) {
                    saveUserAchievement(session.user.id, status.id);
                    void awardAchievementCoins(status.id).then(a => {
                      if (a > 0) void refreshCoinBalance();
                    });
                }
            }
        }
    });

    // All-achievements bonus: fire once when the count crosses 10.
    if (newlyUnlocked > 0 && prevCount < 10 && prevCount + newlyUnlocked >= 10) {
      void awardAllAchievementsBonus().then(b => {
        if (b > 0) {
          void refreshCoinBalance();
          setPendingCoinReward({ amount: b, source: 'achievement_bonus' });
        }
      });
    }
  }, [words, sessions, dailyStats, loadingData, unlockedAchievements, session, isReconciled]);

  // Derived Stats (Merged: DB History + Live Local Updates)
  // We use the DB loaded stats as base.
  // Note: Since we "fire & forget" sync stats on update, local state might be slightly ahead or behind 
  // until next refresh, but for UX responsiveness we can rely on dailyStats state 
  // which we should update locally when tests finish.
  const getStats = (): Record<string, DayStats> => {
    return dailyStats;
  };
  
  const completedStatsRef = useRef(new Set<string>());
  const updateLocalStats = async (summary: CompletedTestSummary) => {
    const userId = session?.user?.id;
    if (!userId || authUserIdRef.current !== userId) throw new Error(copy("Please sign in to save test results.", "请登录后保存测试结果。"));
    if (!summary.roundId || !summary.occurredAt) throw new Error(copy("The original test ID or timestamp is missing.", "测试结果缺少原始编号和时间。"));
    if (!summary.results.length) return;
    const roundKey = `${userId}:${summary.roundId}`;
    if (completedStatsRef.current.has(roundKey)) return;
    const date = getShanghaiDateString(summary.occurredAt);
    const correctCount = summary.results.filter(result => result.correct).length;
    // Persist before any request or optimistic UI. The same ID is used for every retry and reward.
    const added = await enqueuePendingSync({
      id: summary.roundId, userId, date, timestamp: summary.occurredAt,
      testCount: summary.results.length, correctCount, points: summary.totalScore,
      expectedVersion: dailyStats[date]?.version ?? 0,
    });
    completedStatsRef.current.add(roundKey);
    if (authUserIdRef.current !== userId) return;
    if (added) setDailyStats(prev => {
      const current = prev[date] || { date, total: 0, correct: 0, points: 0 };
      return { ...prev, [date]: { ...current, total: current.total + summary.results.length,
        correct: current.correct + correctCount, points: (current.points || 0) + summary.totalScore } };
    });
    setPendingSyncCount(getPendingSyncCount(userId));
    void flushStatsQueue(userId);
  };

  // Account-scoped backup status; stale reads cannot update a different account.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId || loadingData || sessions.length === 0) return;
    let cancelled = false;
    void loadLocalBackup(userId).then(backup => {
      if (cancelled || authUserIdRef.current !== userId) return;
      const statuses = new Map((backup?.sessions ?? []).map(item => [item.id, item.syncStatus]));
      setSessions(prev => prev.map(item => ({ ...item, syncStatus: statuses.get(item.id) ?? 'synced' })));
    }).catch(error => {
      if (!cancelled && authUserIdRef.current === userId) console.warn('[SyncStatusChecker] Backup unavailable:', error);
    });
    return () => { cancelled = true; };
  }, [loadingData, sessions.length, session?.user?.id]);

  // Only fill fields which are still missing, including a compare-before-write guard on the server.
  const backfillWordDictionaryMetadata = useCallback(async (
    userId: string, identityRevision: number, wordId: string, data: DictionaryData | null,
    source: Pick<WordEntry, 'text' | 'language'>,
    signal?: AbortSignal,
  ): Promise<'updated' | 'retry' | 'skipped'> => {
    const isCurrent = () => authUserIdRef.current === userId
      && authIdentityRevisionRef.current === identityRevision && !signal?.aborted;
    if (!data || !isCurrent() || isSupabaseRateLimited()) return 'retry';
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (!isCurrent() || authError || user?.id !== userId || isSupabaseRateLimited()) return 'retry';
    const current = latestWordsRef.current.find(word => word.id === wordId && !word.deleted);
    const sourceKey = normalizeDefinitionBackfillKey(source.text, source.language || 'en');
    if (!current || !needsDictionaryEnrichment(current)
      || normalizeDefinitionBackfillKey(current.text, current.language || 'en') !== sourceKey) return 'skipped';
    const patch = missingDictionaryFields(current, data);
    if (!Object.keys(patch).length) return 'skipped';

    // A meaning chosen on another tab/device while this request is in flight wins.
    let update = supabase.from('words').update(patch).eq('id', wordId).eq('user_id', userId)
      .eq('text', current.text);
    if (signal) update = update.abortSignal(signal);
    const filters = dictionaryBackfillFilters(current, patch, source.language || 'en');
    for (const filter of filters.or) update = update.or(filter);
    for (const [field, value] of filters.equals) update = update.eq(field, value);
    const { data: updated, error } = await update.select('id');
    if (error) throw error;
    if (!isCurrent() || !updated?.length) return 'retry';
    setWords(previous => {
      if (!isCurrent()) return previous;
      const next = previous.map(word => word.id === wordId && !word.deleted
        && normalizeDefinitionBackfillKey(word.text, word.language || 'en') === sourceKey
        ? { ...word, ...missingDictionaryFields(word, data) }
        : word);
      latestWordsRef.current = next;
      return next;
    });
    return 'updated';
  }, []);

  // Background Process
  const processBackgroundData = async (userId: string, wordsToProcess: any[]) => {
    const identityRevision = authIdentityRevisionRef.current;
    const isCurrent = () => authUserIdRef.current === userId
      && authIdentityRevisionRef.current === identityRevision;
    if (!isCurrent()) return;
    if (!wordsToProcess || !Array.isArray(wordsToProcess)) {
      appendImageGenDebug('background_process_invalid_input', { userId, wordsToProcessType: typeof wordsToProcess });
      return;
    }

    appendImageGenDebug('background_process_start', {
      userId,
      total: wordsToProcess.length,
      wordIds: wordsToProcess.map((w: any) => w.id),
      words: wordsToProcess.map((w: any) => w.text),
    });

    const imageGenRuntimeInfo = (aiService as any).getImageGenerationDebugInfo?.();
    appendImageGenDebug('image_gen_runtime_info', imageGenRuntimeInfo || { available: false });
    appendImageGenDebug('image_gen_queue_snapshot', getImageGenerationQueueSnapshot());

    if (wordsToProcess.length === 0) {
      appendImageGenDebug('background_process_no_words', { reason: 'No words selected for processing' });
      return;
    }

    for (const w of wordsToProcess) {
      if (!isCurrent()) return;
        appendImageGenDebug('word_process_begin', { id: w.id, text: w.text, hasImagePath: !!w.image_path, hasAssetId: !!w.image_asset_id, language: w.language || 'en' });

      if (!w.image_path && !w.image_asset_id) {
        try {
                appendImageGenDebug('image_gen_request_start', { id: w.id, text: w.text });
          const generated = await requestQueuedWordImage(w.text, { language: w.language || 'en', partOfSpeech: posOf(w) });
          if (!isCurrent()) return;

          // Edge function now handles upload and word linking
          const publicUrl = generated.publicUrl;
          const assetId = generated.assetId;

          if (publicUrl || generated.dataUrl) {
            appendImageGenDebug('image_gen_request_success', {
              id: w.id, text: w.text, provider: generated.providerId,
              source: generated.source, hasPublicUrl: !!publicUrl, hasAssetId: !!assetId,
            });

            // Client-side WebP conversion + upload to replace any non-WebP stored by edge function
            let finalUrl = publicUrl;
            if (generated.dataUrl && generated.source === 'generated') {
              try {
                const webpBlob = await compressToWebP(generated.dataUrl, 1024, 1024, 0.8);
                if (webpBlob) {
                  const reader = new FileReader();
                  const webpDataUrl = await new Promise<string>((resolve) => { reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(webpBlob); });
                  if (!isCurrent()) return;
                  // Upload the WebP to replace edge function's potentially-PNG storage
                  await supabase.functions.invoke('image-migrate', {
                    body: { action: 'upload-converted', word: w.text, language: w.language || 'en', webpDataUrl, sizeBytes: webpBlob.size },
                  });
                  appendImageGenDebug('image_webp_convert_success', { id: w.id, text: w.text, originalSize: generated.dataUrl.length, webpSize: webpBlob.size });
                }
              } catch (e) {
                appendImageGenDebug('image_webp_convert_failed', { id: w.id, text: w.text, error: String(e) });
              }
            }

            // Cache in browser if dataUrl is available
            if (generated.dataUrl) {
              await cacheGeneratedImageForWord({ id: w.id, text: w.text, language: w.language || 'en' }, generated.dataUrl);
              if (!isCurrent()) return;
              setCachedImageWordIds(prev => { const next = new Set(prev); next.add(w.id); return next; });
              setCachedImageDataUrls(prev => ({ ...prev, [w.id]: generated.dataUrl! }));
            }

            if (!isCurrent()) return;
            showLocalizedNotification(`Image generated: ${w.text}`, `🖼️ 已生成图片：${w.text}`, 'success');
            setWords(prev => prev.map(word =>
              word.id === w.id
              ? { ...word, image_url: publicUrl || word.image_url, image_asset_id: assetId || word.image_asset_id }
              : word
            ));
          } else {
            appendImageGenDebug('image_gen_request_failed', { id: w.id, text: w.text, reason: 'no publicUrl or dataUrl' });
            showLocalizedNotification(`Image generation failed for ${w.text}, including the fallback service.`, `⚠️ 图片生成失败：${w.text}（已自动尝试备用服务）`, 'warning');
          }
        } catch (e) {
          if (!isCurrent()) return;
          console.warn(`Background image generation failed for ${w.text}:`, e);
          appendImageGenDebug('image_gen_exception', { id: w.id, text: w.text, error: (e as any)?.message || String(e) });
          showLocalizedNotification(`Image generation failed: ${w.text}`, `⚠️ 图片生成异常：${w.text}`, 'warning');
        }
      } else {
        appendImageGenDebug('word_skip_has_existing_image', { id: w.id, text: w.text, imagePath: w.image_path, assetId: w.image_asset_id });
      }

      // Historical meanings are handled by the shared paced queue below.
    }

      appendImageGenDebug('background_process_complete', { total: wordsToProcess.length });
  };

  const handleGenerateImageForWord = useCallback(async (
    word: { id: string; text: string; language?: string | null; hasExistingImage?: boolean }
  ): Promise<boolean> => {
    if (!session?.user?.id) {
      showLocalizedNotification("Please sign in before generating images.", "请先登录后再生成图片", 'warning');
      return false;
    }

    if (word.hasExistingImage) {
      const confirmed = window.confirm(copy(`"${word.text}" already has an image. Generate a new one and replace it?`, `"${word.text}" 已有图片，是否重新生成并替换当前图片？`));
      if (!confirmed) return false;
    }

    appendImageGenDebug('manual_image_gen_start', {
      id: word.id,
      text: word.text,
      language: word.language || 'en',
      hasExistingImage: !!word.hasExistingImage,
    });
    appendImageGenDebug('manual_image_gen_queue_before_enqueue', getImageGenerationQueueSnapshot());
    showLocalizedNotification(`Image queued: ${word.text}`, `🕒 已加入生图队列：${word.text}`, 'success');

    try {
      const generated = await requestQueuedWordImage(word.text, {
        language: word.language || 'en',
        force: !!word.hasExistingImage, // Force regeneration if replacing
      });

      const publicUrl = generated.publicUrl;
      const assetId = generated.assetId;

      if (!publicUrl && !generated.dataUrl) {
        appendImageGenDebug('manual_image_gen_failed', { id: word.id, text: word.text, reason: 'no publicUrl or dataUrl' });
        showLocalizedNotification(`Image generation failed: ${word.text}`, `⚠️ 图片生成失败：${word.text}`, 'warning');
        return false;
      }

      // Client-side WebP conversion + upload to replace any non-WebP stored by edge function
      if (generated.dataUrl && generated.source === 'generated') {
        try {
          const webpBlob = await compressToWebP(generated.dataUrl, 1024, 1024, 0.8);
          if (webpBlob) {
            const reader = new FileReader();
            const webpDataUrl = await new Promise<string>((resolve) => { reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(webpBlob); });
            await supabase.functions.invoke('image-migrate', {
              body: { action: 'upload-converted', word: word.text, language: word.language || 'en', webpDataUrl, sizeBytes: webpBlob.size },
            });
            appendImageGenDebug('manual_webp_convert_success', { id: word.id, text: word.text, webpSize: webpBlob.size });
          }
        } catch (e) {
          appendImageGenDebug('manual_webp_convert_failed', { id: word.id, text: word.text, error: String(e) });
        }
      }

      // Cache in browser if dataUrl is available
      if (generated.dataUrl) {
        await cacheGeneratedImageForWord({ id: word.id, text: word.text, language: word.language || 'en' }, generated.dataUrl);
      }

      setCachedImageWordIds(prev => { const next = new Set(prev); next.add(word.id); return next; });
      if (generated.dataUrl) {
        setCachedImageDataUrls(prev => ({ ...prev, [word.id]: generated.dataUrl! }));
      }
      setWords(prev => prev.map(item =>
        item.id === word.id ? {
          ...item,
          image_url: publicUrl || item.image_url,
          image_asset_id: assetId || item.image_asset_id,
        } : item
      ));

      appendImageGenDebug('manual_image_gen_success', {
        id: word.id, text: word.text, publicUrl, assetId, provider: generated.providerId, source: generated.source,
      });
      showLocalizedNotification(`Image generated: ${word.text}`, `🖼️ 已${word.hasExistingImage ? '重新生成' : '生成'}图片：${word.text}`, 'success');
      return true;
    } catch (error: any) {
      appendImageGenDebug('manual_image_gen_exception', { id: word.id, text: word.text, error: error?.message || String(error) });
      showLocalizedNotification(`Image generation failed: ${word.text}`, `⚠️ 手动生图异常：${word.text}`, 'warning');
      return false;
    }
  }, [appendImageGenDebug, session?.user?.id]);

  // Handle Save (New Session or Update Existing)
  const handleSaveSession = async (
    wordList: EditableWord[], 
    deletedIds: string[]
  ) => {
    if (!session?.user) return;
    
    try {
      const idsToProcess = new Set<string>();

      if (editingSessionId) {
        // UPDATE EXISTING SESSION
        // Words without IDs are new additions
        const addedWords = wordList.filter(w => !w.id); 
        
        // Words WITH IDs are existing words, check for updates
        const existingWordsInput = wordList.filter(w => !!w.id);
        const originalSessionWords = words.filter(w => w.sessionId === editingSessionId);
        
        const updatedWords = existingWordsInput.filter(w => {
             // Find original to compare
             const original = originalSessionWords.find(ow => ow.id === w.id);
             if (!original) return false;

             // Check if text changed or if new image provided (imageBase64)
             // Note: client side 'imageBase64' presence indicates a new image upload intention
             const textChanged = w.text.trim() !== original.text.trim();
             const hasNewImage = !!w.imageBase64;
             const selectedMeaningChanged = (w.selected_meaning_key || null) !== (original.selected_meaning_key || null);
             const meaningListChanged = JSON.stringify(w.meaning_options || []) !== JSON.stringify(original.meaning_options || []);
             const definitionChanged = (w.definition_cn || null) !== (original.definition_cn || null)
               || (w.definition_en || null) !== (original.definition_en || null);
             
             return textChanged || hasNewImage || selectedMeaningChanged || meaningListChanged || definitionChanged;
        }).map(w => ({
            id: w.id!,
            text: w.text,
          imageBase64: w.imageBase64,
          definition_cn: w.definition_cn,
          definition_en: w.definition_en,
          meaning_options: w.meaning_options,
          selected_meaning_key: w.selected_meaning_key,
          language: w.language
        }));

        const { newWordsData } = await modifySession(session.user.id, editingSessionId, addedWords, deletedIds, updatedWords);
        appendImageGenDebug('save_session_edit_mode', {
          sessionId: editingSessionId,
          addedWordsCount: addedWords.length,
          updatedWordsCount: updatedWords.length,
          newWordsSavedCount: newWordsData?.length || 0,
        });
        
        newWordsData.forEach((w: any) => idsToProcess.add(w.id));
        updatedWords.forEach(w => idsToProcess.add(w.id));

      } else {
        // CREATE NEW SESSION
        const { wordsData } = await saveSessionData(session.user.id, wordList.length, wordList);
        appendImageGenDebug('save_session_create_mode', {
          inputWordCount: wordList.length,
          savedWordsCount: wordsData?.length || 0,
          inputWords: wordList.map(w => w.text),
        });
        wordsData.forEach((w: any) => idsToProcess.add(w.id));
      }
      
      // RELOAD DATA IMMEDIATELY (Blocking)
      // This ensures that when we switch to dashboard, the data is FRESH.
      const { sessions: dashboardSessions, words: dashboardWords } = await fetchUserData(session.user.id);
        if (authUserIdRef.current !== session.user.id) return;
      setSessions(dashboardSessions);
      setWords(dashboardWords);

      setMode('DASHBOARD');
      setEditingSessionId(null);

      // Trigger Background Process
      const wordsToProcess = dashboardWords.filter(w => idsToProcess.has(w.id));
      appendImageGenDebug('post_save_process_selection', {
        idsToProcessCount: idsToProcess.size,
        wordsToProcessCount: wordsToProcess.length,
        wordsToProcess: wordsToProcess.map(w => ({ id: w.id, text: w.text, hasImagePath: !!w.image_path })),
      });

      if (idsToProcess.size > 0 && wordsToProcess.length === 0) {
        showLocalizedNotification("Image generation could not start. No matching saved words were found. Please try again.", "⚠️ 生图任务未启动：保存后未匹配到可处理词条（请查看控制台 dumpImageGenDebug()）", 'warning');
      }

      processBackgroundData(session.user.id, wordsToProcess);

      // ✅ 成功保存到云端，清除本地备份
      if (editingSessionId) {
        const localBackup = await loadLocalBackup(session?.user?.id);
        if (localBackup) {
          const updatedBackup = {
            ...localBackup,
            sessions: localBackup.sessions.filter(s => s.id !== editingSessionId)
          };
          await saveLocalBackup(updatedBackup, session?.user?.id);
        }
      }

    } catch (e) {
      console.error("❌ Failed to save session to cloud:", e);

      // 💾 保存到本地备份（离线优先模式）
      const sessionId = editingSessionId || `local_${Date.now()}`;
      const sessionData: InputSession = {
        id: sessionId,
        timestamp: Date.now(),
        wordCount: wordList.length,
        targetCount: wordList.length,
        deleted: false,
        libraryTag: 'Custom'
      };

      // 准备单词数据（不包含 base64 图片，避免 localStorage 超限）
      const wordsData: WordEntry[] = wordList.map((w, idx) => {
        const existingWord = w.id ? words.find(ow => ow.id === w.id) : undefined;
        return {
          id: w.id || `${sessionId}_word_${idx}`,
          text: w.text,
          timestamp: existingWord?.timestamp || Date.now(),
          sessionId: sessionId,
          correct: existingWord?.correct || false,
          tested: existingWord?.tested || false,
          image_path: undefined, // 不存储本地图片到 localStorage
          image_url: undefined,
          error_count: existingWord?.error_count || 0,
          best_time_ms: existingWord?.best_time_ms || null,
          last_tested: existingWord?.last_tested || null,
          phonetic: existingWord?.phonetic || null,
          audio_url: existingWord?.audio_url || null,
          definition_cn: w.definition_cn || existingWord?.definition_cn || null,
          definition_en: w.definition_en || existingWord?.definition_en || null,
          meaning_options: w.meaning_options || existingWord?.meaning_options || [],
          selected_meaning_key: w.selected_meaning_key || existingWord?.selected_meaning_key || null,
          deleted: false,
          tags: ['Custom']
        };
      });

      // 保存到本地
  const savedLocally = await saveSessionToLocal(sessionData, wordsData, 'pending', session.user.id);

      if (!savedLocally) {
        showLocalizedNotification("Local storage is full and the offline backup failed. Keep this page open, free some storage, and save again.", "❌ 当前设备本地存储已满，离线备份失败。请先不要离开此页面，清理设备存储后重试保存。", 'error');
        return;
      }

      // 更新本地状态
      setSessions(prev => {
        const existing = prev.find(s => s.id === sessionId);
        if (existing) {
          return prev.map(s => s.id === sessionId ? sessionData : s);
        } else {
          return [...prev, sessionData];
        }
      });

      setWords(prev => {
        const existingIds = new Set(prev.filter(w => w.sessionId === sessionId).map(w => w.id));
        const newWords = wordsData.filter(w => !existingIds.has(w.id));
        return [...prev, ...newWords];
      });

      setMode('DASHBOARD');
      setEditingSessionId(null);

      // 用户友好提示
      showLocalizedNotification("Saved locally due to connection error. Sync will resume when you reconnect.", "连接失败，数据已保存在本机，网络恢复后会自动同步。", 'warning');
    }
  };

  const processDefinitionBackfillQueue = useCallback(async () => {
    const userId = session?.user?.id;
    const identityRevision = authIdentityRevisionRef.current;
    const epoch = definitionBackfillEpochRef.current;
    const controller = new AbortController();
    const isCurrent = () => !!userId && authUserIdRef.current === userId
      && authIdentityRevisionRef.current === identityRevision && definitionBackfillEpochRef.current === epoch && !controller.signal.aborted;
    if (definitionBackfillRunningRef.current || !isCurrent()) return;
    definitionBackfillRunningRef.current = true;
    definitionBackfillControllerRef.current = controller;
    let restartAllowed = true;
    const wait = (milliseconds: number) => new Promise<void>(resolve => window.setTimeout(resolve, Math.min(milliseconds, 30_000)));

    try {
      while (isCurrent() && definitionBackfillQueueRef.current.size > 0) {
        const now = Date.now();
        const next = [...definitionBackfillQueueRef.current.entries()]
          .find(([key]) => (definitionBackfillRetryRef.current.get(key) || 0) <= now);
        if (!next) {
          let earliest = Infinity;
          for (const timestamp of definitionBackfillRetryRef.current.values()) earliest = Math.min(earliest, timestamp);
          await wait(Number.isFinite(earliest) ? Math.max(1, earliest - now) : 30_000);
          continue;
        }
        const [queueKey, candidate] = next;
        const matchesCandidate = (word: WordEntry) => !word.deleted && needsDictionaryEnrichment(word)
          && (candidate.lexemeId && word.lexeme_id
            ? word.lexeme_id === candidate.lexemeId
            : normalizeDefinitionBackfillKey(word.text, word.language || 'en')
              === normalizeDefinitionBackfillKey(candidate.text, candidate.language));
        try {
          if (!latestWordsRef.current.some(matchesCandidate)) {
            definitionBackfillQueueRef.current.delete(queueKey);
            definitionBackfillRetryRef.current.delete(queueKey);
            definitionBackfillCompletedRef.current.add(queueKey);
            continue;
          }
          let storage: Storage | undefined;
          let locks: LockManager | undefined;
          try { storage = window.localStorage; locks = navigator.locks; } catch { /* Stop background work when coordination is unavailable. */ }
          const permit = await withDefinitionBackfillPermit(storage, locks, isCurrent, async () => {
            definitionBackfillInFlightRef.current.add(queueKey);
            try {
              if (!isCurrent() || isSupabaseRateLimited()) return 'paused' as const;
              // Read previously saved shared meanings only. Translation is left
              // to the server's globally paced worker; manual input stays immediate.
              const dict = await fetchSavedDictionaryData(candidate.text, candidate.language || 'en', controller.signal);
              if (!isCurrent()) return 'cancelled' as const;
              if (isSupabaseRateLimited()) return 'paused' as const;
              if (!dict?.definition_cn) return 'missing' as const;
              const word = latestWordsRef.current.find(matchesCandidate);
              if (!word) return 'processed' as const;
              const result = await backfillWordDictionaryMetadata(userId, identityRevision, word.id, dict, candidate, controller.signal);
              if (!isCurrent()) return 'cancelled' as const;
              return isSupabaseRateLimited() ? 'paused' as const : result === 'retry' ? 'missing' as const : 'processed' as const;
            } finally {
              if (isCurrent()) definitionBackfillInFlightRef.current.delete(queueKey);
            }
          });
          if (!isCurrent()) return;
          if (permit.kind === 'unavailable') { restartAllowed = false; return; }
          if (permit.kind === 'cancelled') return;
          if (permit.kind === 'wait') { await wait(permit.ms); continue; }
          if (permit.value === 'cancelled') return;
          // Revisit absent shared meanings later instead of marking them done.
          // One personal row per permit also bounds duplicate-word writes.
          const retryDelay = permit.value === 'missing' ? DEFINITION_BACKFILL_RETRY_MS
            : permit.value === 'processed' ? DEFINITION_BACKFILL_INTERVAL_MS : 0;
          definitionBackfillRetryRef.current.set(queueKey, Date.now() + retryDelay);
          definitionBackfillQueueRef.current.delete(queueKey);
          definitionBackfillQueueRef.current.set(queueKey, candidate);
        } catch (error) {
          if (!isCurrent()) return;
          definitionBackfillRetryRef.current.set(queueKey, Date.now() + DEFINITION_BACKFILL_RETRY_MS);
          definitionBackfillQueueRef.current.delete(queueKey);
          definitionBackfillQueueRef.current.set(queueKey, candidate);
          console.warn(`Failed to backfill Chinese definition for ${candidate.text}:`, error);
        }
      }
    } finally {
      if (definitionBackfillControllerRef.current === controller) definitionBackfillControllerRef.current = null;
      // An obsolete A→B→A worker must not clear the newer account's running flag or queue.
      if (isCurrent()) {
        definitionBackfillRunningRef.current = false;
        if (restartAllowed && definitionBackfillQueueRef.current.size > 0) void processDefinitionBackfillQueue();
      }
    }
  }, [session?.user?.id, backfillWordDictionaryMetadata]);

  useEffect(() => {
    const identityRevision = authIdentityRevisionRef.current;
    if (definitionBackfillIdentityRevisionRef.current !== identityRevision) {
      definitionBackfillIdentityRevisionRef.current = identityRevision;
      definitionBackfillInFlightRef.current.clear();
      definitionBackfillQueueRef.current.clear();
      definitionBackfillCompletedRef.current.clear();
      definitionBackfillRetryRef.current.clear();
      definitionBackfillRunningRef.current = false;
    }
    if (!session?.user?.id || words.length === 0) return;

    words.forEach(word => {
      if (word.deleted || !needsDictionaryEnrichment(word)) return;

      const queueKey = word.lexeme_id || normalizeDefinitionBackfillKey(word.text, word.language || 'en');
      if (
        definitionBackfillCompletedRef.current.has(queueKey)
        || definitionBackfillInFlightRef.current.has(queueKey)
        || definitionBackfillQueueRef.current.has(queueKey)
      ) {
        return;
      }

      definitionBackfillQueueRef.current.set(queueKey, {
        text: word.text,
        language: word.language || 'en',
        lexemeId: word.lexeme_id,
      });
    });

    void processDefinitionBackfillQueue();
  }, [session?.user?.id, words, processDefinitionBackfillQueue]);

  const handleExecuteDelete = async () => {
      console.log("🔴 handleExecuteDelete called");
      console.log("📋 Session user:", session?.user?.id);
      console.log("📋 IDs to delete:", idsToDelete);
      
      if (!session?.user || idsToDelete.length === 0) {
          console.error("❌ Early return: no user or no IDs");
          return;
      }
      
      setIsDeleting(true);
      setDeleteProgress({ step: 'fetching', message: 'Starting deletion...' });
      
      try {
          // 1. Delete from Cloud with progress callback
          console.log("🗑️ Calling deleteSessions...");
          await deleteSessions(session.user.id, idsToDelete, (progress) => {
              setDeleteProgress(progress);
              console.log("📊 Delete progress:", progress);
          });
          console.log("✅ deleteSessions completed");

          // 2. Update Local State (Soft Delete)
          console.log("🔄 Updating local state...");
          setSessions(prev => prev.map(s => idsToDelete.includes(s.id) ? { ...s, deleted: true } : s));
          setWords(prev => prev.map(w => idsToDelete.includes(w.sessionId) ? { ...w, deleted: true } : w));
          
          // 3. Clear Selection if deleted
          const newSelected = new Set(selectedDashboardSessionIds);
          idsToDelete.forEach(id => newSelected.delete(id));
          setSelectedDashboardSessionIds(newSelected);

          // 4. Close Modal
          setShowDeleteConfirm(false);
          setIdsToDelete([]);
          setDeleteProgress(null);
          console.log("✅ Delete completed successfully");
          playDing(); // Success sound
      } catch (e) {
          console.error("❌ Delete failed", e);
          setDeleteProgress({ step: 'complete', message: `Error: ${(e as Error).message}` });
          alert(copy("Could not delete the selected sessions. Please try again.", "无法删除所选学习批次，请重试。"));
      } finally {
          setIsDeleting(false);
      }
  };

  const handleUpdateWordResult = async (id: string, correct: boolean) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, correct, tested: true } : w));
    await updateWordStatus(id, correct);
  };

  const handleInputModeDeleteWord = async (wordId: string) => {
      console.log("🔧 handleInputModeDeleteWord called with wordId:", wordId);
      console.log("📋 Current session:", session?.user?.id);
      console.log("📝 Editing session ID:", editingSessionId);
      
      if (!session?.user) {
          console.error("❌ No session user found");
          return;
      }
      
      try {
          if (editingSessionId) {
             console.log("🗑️ Deleting individual word:", wordId, "from session:", editingSessionId);
             await modifySession(session.user.id, editingSessionId, [], [wordId]);
             console.log("✅ modifySession completed successfully");
             
             // Update local state immediately
             setWords(prev => prev.filter(w => w.id !== wordId));
             setSessions(prev => prev.map(s => 
                 s.id === editingSessionId 
                 ? { ...s, wordCount: Math.max(0, s.wordCount - 1) } 
                 : s
             ));
             console.log("✅ Local state updated");
             playDing();
          } else {
              console.error("⚠️ No editingSessionId found");
          }
      } catch (e) {
          console.error("❌ Delete individual word failed", e);
          alert(copy("Could not delete this word. Please try again.", "无法删除这个单词，请重试。"));
      }
  };

  const applyCloudSession = (userId: string, data: { session: InputSession; words: WordEntry[] }) => {
    if (authUserIdRef.current !== userId) return;
    setSessions(prev => prev.map(item => item.id === data.session.id ? { ...data.session, syncStatus: 'synced' } : item));
    // Replace by session, preserving words whose IDs also exist in the cloud response.
    const next = overlayLearningProgress(userId, [
      ...latestWordsRef.current.filter(word => word.sessionId !== data.session.id), ...data.words,
    ]);
    latestWordsRef.current = next;
    setWords(next);
  };

  const refreshAfterSessionSync = async (userId: string) => {
    const cloud = await fetchUserData(userId);
    if (authUserIdRef.current !== userId) return;
    const backup = await loadLocalBackup(userId);
    if (authUserIdRef.current !== userId) return;
    // Keep other offline edits visible while refreshing one successful upload.
    const pending = backup?.sessions.filter(item => item.syncStatus !== 'synced') ?? [];
    const pendingIds = new Set(pending.map(item => item.id));
    const currentWords = overlayLearningProgress(userId, [
      ...cloud.words.filter(word => !pendingIds.has(word.sessionId)),
      ...(backup?.words.filter(word => pendingIds.has(word.sessionId)) ?? []),
    ]);
    latestWordsRef.current = currentWords;
    setWords(currentWords);
    setSessions([...cloud.sessions.filter(item => !pendingIds.has(item.id)), ...pending]);
  };

  const handleManualSync = async (sessionId: string) => {
    const userId = session?.user?.id;
    if (!userId || authUserIdRef.current !== userId) return;
    const isCurrent = () => authUserIdRef.current === userId;
    setSyncingSessionId(sessionId);
    try {
      const localBackup = await loadLocalBackup(userId);
      if (!isCurrent()) return;
      const localSession = localBackup?.sessions.find(item => item.id === sessionId);
      if (!localSession) {
        await refreshAfterSessionSync(userId);
        if (isCurrent()) showLocalizedNotification("Data refreshed from the cloud.", "✅ 数据已从云端刷新", 'success');
        return;
      }
      const localWords = localBackup.words.filter(word => word.sessionId === sessionId);
      const result = await syncSessionToCloud(userId, localSession, localWords);
      if (!isCurrent()) return;
      const applied = await persistSessionSyncResult(userId, localSession, result);
      if (!isCurrent()) return;
      if (!applied) {
        showLocalizedNotification("Your library changed during sync. Those edits are safe and will sync later.", "本地词库在同步期间有新修改，已保留，稍后继续同步。", 'warning');
        return;
      }
      if (result.success) {
        if (result.cloudData) applyCloudSession(userId, result.cloudData);
        else await refreshAfterSessionSync(userId);
        if (isCurrent()) showLocalizedNotification("Sync complete. Your learning progress is preserved.", "✅ 同步完成，学习进度已保留", 'success');
      } else {
        const syncStatus = result.action === 'conflict' ? 'conflict' : 'failed';
        setSessions(prev => prev.map(item => item.id === sessionId ? { ...item, syncStatus } : item));
        if (result.action === 'conflict' && result.conflictData) {
          setConflictModal({ sessionId, cloud: result.conflictData.cloud, local: result.conflictData.local });
        } else showLocalizedNotification("Sync is incomplete. Your local records are safe; please try again.", `同步暂未完成：${result.message}`, 'warning');
      }
    } catch (error) {
      if (isCurrent()) showLocalizedNotification("Sync is incomplete. Your local records are safe; please try again.", `同步暂未完成：${(error as Error).message}`, 'warning');
    } finally {
      if (isCurrent()) setSyncingSessionId(null);
    }
  };

  const handleConfirmConflictResolution = async () => {
    const userId = session?.user?.id;
    const conflict = conflictModal;
    const choice = conflictChoice;
    if (!conflict || !choice || !userId || authUserIdRef.current !== userId) return;
    const isCurrent = () => authUserIdRef.current === userId;
    try {
      const backup = await loadLocalBackup(userId);
      if (!isCurrent()) return;
      const localSession = backup?.sessions.find(item => item.id === conflict.sessionId);
      if (!localSession) throw new Error(copy("The local conflict backup is missing. No data was removed.", "本地冲突备份不存在，未清除任何数据。"));
      const localWords = backup.words.filter(word => word.sessionId === conflict.sessionId);
      if (choice === 'local' && localSession.wordCount > 0 && !localWords.length) throw new Error(copy("The local backup is missing words and cannot be uploaded safely.", "本地备份缺少单词，无法安全上传。"));
      const cloud = await fetchUserData(userId);
      if (!isCurrent()) return;
      const result = await resolveConflict(userId, conflict.sessionId, choice,
        { session: localSession, words: localWords },
        { session: cloud.sessions.find(item => item.id === conflict.sessionId) ?? conflict.cloud,
          words: cloud.words.filter(word => word.sessionId === conflict.sessionId) });
      if (!isCurrent()) return;
      if (!result.success) throw new Error(result.message || copy("The conflict is not resolved yet.", "冲突尚未解决"));
      const applied = await persistSessionSyncResult(userId, localSession, result);
      if (!isCurrent()) return;
      if (!applied) throw new Error(copy("The local library has changed. Please review the conflict again.", "本地词库已有新修改，请重新确认冲突。"));
      await refreshAfterSessionSync(userId);
      if (!isCurrent()) return;
      setConflictModal(null);
      setConflictChoice(null);
      showLocalizedNotification("Conflict resolved. Your learning progress is preserved.", "✅ 冲突已解决，学习进度已保留", 'success');
    } catch (error) {
      if (isCurrent()) showLocalizedNotification("The conflict is not resolved yet. Please review and try again.", `冲突尚未解决：${(error as Error).message}`, 'warning');
    }
  };

  // Older content sync shares the same captured account guard as learning sync.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    let cancelled = false;
    let running = false;
    const isCurrent = () => !cancelled && authUserIdRef.current === userId;
    const syncContent = async () => {
      if (!isCurrent() || running) return;
      running = true;
      try {
        const backup = await loadLocalBackup(userId);
        if (!isCurrent() || !backup?.sessions.some(item => item.syncStatus === 'pending' || item.syncStatus === 'failed')) return;
        const result = await syncAllPendingSessions(userId);
        if (!isCurrent()) return;
        if (result.synced > 0) await refreshAfterSessionSync(userId);
        if (isCurrent() && result.conflicts > 0) showLocalizedNotification("A library sync conflict needs your review.", "检测到词库同步冲突，请手动处理。", 'warning');
      } catch (error) {
        if (isCurrent()) console.warn('[ContentSync] Backup preserved for retry:', error);
      } finally { running = false; }
    };
    const onOnline = () => { void syncContent(); };
    const onOffline = () => {
      if (isCurrent()) showLocalizedNotification("You are offline. Learning records will be saved on this device.", "网络已断开，学习记录将保存在本机。", 'warning');
    };
    const timer = window.setInterval(() => { void syncContent(); }, 30 * 60 * 1000);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [session?.user?.id]);

  const handleStartEdit = (sessionId: string) => {
    setEditingSessionId(sessionId);
    setMode('INPUT');
  };

  const handleStartTest = (sessionIds: string[]) => {
    setTestConfig({ kind: 'CLASSIC', sessionIds });
    setMode('TEST');
  };

  const handleStartTestFromLibrary = (wordIds: string[]) => {
    setTestConfig({ kind: 'CLASSIC', wordIds });
    setMode('TEST');
  };

  const handleLearningWordUpdate = (id: string, updates: Partial<WordEntry>, attempt?: { result: LearningResult; eventId: string; occurredAt: number }) => {
    const userId = session?.user?.id;
    const current = latestWordsRef.current.find(word => word.id === id);
    if (!userId || authUserIdRef.current !== userId || !current || !attempt) throw new Error(copy("The learning record is missing its account or answer event.", "学习记录缺少账号或真实作答事件。"));
    try {
      const updated = persistLearningAttempt(userId, current, attempt.result, attempt.eventId, attempt.occurredAt);
      const next = latestWordsRef.current.map(word => word.id === id ? { ...updated, tags: updates.tags ?? updated.tags } : word);
      latestWordsRef.current = next;
      setWords(next);
      void syncPendingLearningProgress(userId).then(() => {
        if (authUserIdRef.current !== userId) return;
        const merged = overlayLearningProgress(userId, latestWordsRef.current);
        latestWordsRef.current = merged; setWords(merged);
      }).catch(error => console.warn('[LearningSync] Saved locally:', error));
    } catch (error) {
      showLocalizedNotification("Learning records could not be saved locally. Keep this page open and try again.", "本机学习记录保存失败，请保留页面并重试。", 'error');
      throw error;
    }
  };

  const saveGameLearning = async (roundId: string, occurredAt: number, results: LearningResult[]) => {
    const userId = session?.user?.id;
    if (!userId || authUserIdRef.current !== userId) throw new Error(copy("Please sign in to save learning records.", "请登录后保存学习记录。"));
    const next = recordLearningRound(userId, roundId, occurredAt, results, latestWordsRef.current);
    latestWordsRef.current = next;
    setWords(next);
    showLocalizedNotification("Progress saved on this device. Syncing in the background.", "学习进度已保存在本机，正在后台同步。", 'success');
    void syncPendingLearningProgress(userId).then(result => {
      if (authUserIdRef.current !== userId) return;
      const merged = overlayLearningProgress(userId, latestWordsRef.current);
      latestWordsRef.current = merged; setWords(merged);
      if (result.pending > 0) showLocalizedNotification("Progress saved on this device. Cloud sync is still pending.", "学习进度已保存在本机，云端仍待同步。", 'warning');
    }).catch(error => console.warn('[LearningSync] Saved locally:', error));
  };

  const handleStartPuzzleGame = () => {
    setTestConfig({ kind: 'PUZZLE' });
    setMode('TEST');
  };

  const reviewDay = getShanghaiDateString(reviewClock);
  const reviewDataReady = !loadingData && !dataError
    && loadedDataIdentityRef.current?.userId === dataUserId
    && loadedDataIdentityRef.current?.revision === dataIdentityRevision;
  const reviewBlocked = reviewDay !== loginReviewDay || mode !== 'DASHBOARD' || !!dailyLoginReward || !!pendingCoinReward
    || !isReconciled || showAccountPanel || showGlobalLeaderboard
    || showQuickTestModal || showGamePickerModal || showDeleteConfirm || !!conflictModal;
  const reviewPending = shouldShowDailyReviewReminder({ userId: dataUserId, day: reviewDay, dueCount: dueWords.length,
    dataReady: reviewDataReady, rewardReady: dailyRewardSettled, blocked: reviewBlocked }, reviewHistoryRef.current);
  useEffect(() => {
    if (reviewPending) {
      reviewHistoryRef.current.markSeen(dataUserId!, reviewDay);
      setReviewReminderOwner(dataUserId);
    }
  }, [dataUserId, reviewDay, reviewPending]);

  if (!isSupabaseConfigured) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dark-charcoal p-4 text-center animate-in fade-in duration-700">
        <span className="material-symbols-outlined text-6xl text-red-500 mb-6 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]">cloud_off</span>
        <h1 className="font-headline text-4xl text-white mb-4 tracking-wider">{t.neuralLinkSevered}</h1>
        <div className="bg-light-charcoal border border-mid-charcoal p-6 rounded-2xl max-w-lg shadow-2xl">
          <p className="font-mono text-text-dark text-sm mb-4 leading-relaxed">
            {t.dbMissingDesc}
          </p>
          <div className="bg-dark-charcoal p-4 rounded-lg text-left mb-4 overflow-x-auto">
             <code className="text-xs font-mono text-electric-blue block mb-2">SUPABASE_URL=...</code>
             <code className="text-xs font-mono text-electric-blue block">SUPABASE_ANON_KEY=...</code>
          </div>
          <p className="text-xs text-text-dark uppercase tracking-widest">{t.configureEnvVars}</p>
        </div>
      </div>
    );
  }

  // Password reset page has highest priority
  if (resetToken) {
    // Show password reset page - don't sign out as the access token will set the session
    return <PasswordReset accessToken={resetToken} onClose={() => setResetToken(null)} />;
  }

  // Watcha OAuth callback handling
  if (isWatchaCallback) {
    return <WatchaCallback />;
  }

  // Password forgot request page
  if (showPasswordForgot) {
    return <PasswordForgotRequest onBackToLogin={() => setShowPasswordForgot(false)} />;
  }

  if (!session) {
    if (showLanding) {
      return <LandingPage onStart={() => setShowLanding(false)} />;
    }
    return <Auth onForgotPassword={() => setShowPasswordForgot(true)} />;
  }

  if (loadingData && words.length === 0 && sessions.length === 0) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-dark-charcoal text-electric-blue font-headline text-2xl animate-pulse">
            {t.syncingNeuralLink}
        </div>
    );
  }

  if (dataError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-dark-charcoal p-4 text-center">
            <span className="material-symbols-outlined text-5xl text-red-500 mb-4">signal_wifi_off</span>
            <p className="text-white font-headline text-2xl mb-4">{dataError}</p>
            <button 
                onClick={refreshData}
                className="px-6 py-2 bg-mid-charcoal text-electric-blue rounded-lg hover:bg-electric-blue hover:text-charcoal transition-colors"
            >
                {t.retryConnection}
            </button>
        </div>
      );
  }

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden relative bg-charcoal">

      {/* 🔔 Notification Toast */}
      {notification && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[200] px-6 py-4 rounded-2xl shadow-2xl border-2 flex items-center gap-3 animate-in slide-in-from-top-4 fade-in duration-300 ${
            notification.type === 'success'
              ? 'bg-electric-green/20 border-electric-green text-white'
              : notification.type === 'warning'
              ? 'bg-yellow-500/20 border-yellow-500 text-white'
              : 'bg-red-500/20 border-red-500 text-white'
          }`}
        >
          <span className="material-symbols-outlined text-2xl">
            {notification.type === 'success'
              ? 'check_circle'
              : notification.type === 'warning'
              ? 'warning'
              : 'error'}
          </span>
          <p className="font-medium">{typeof notification.message === 'string' ? notification.message : isZh ? notification.message.zh : notification.message.en}</p>
        </div>
      )}

      {/* ✅ NEW (Phase C): Pending Sync Queue Indicator */}
      {pendingSyncCount > 0 && (
        <div className="fixed top-4 right-4 z-[150] px-4 py-2 rounded-lg shadow-lg bg-yellow-500/90 border border-yellow-500 text-white flex items-center gap-2 animate-in slide-in-from-right-4 fade-in duration-300">
          <span className="material-symbols-outlined text-lg">sync_problem</span>
          <span className="text-sm font-medium">
            {copy(`${pendingSyncCount} pending sync`, `${pendingSyncCount} 条待同步`)}
          </span>
        </div>
      )}

      {/* ⚠️ Conflict Resolution Modal */}
      {conflictModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="bg-light-charcoal border-2 border-yellow-500 rounded-3xl p-8 max-w-2xl w-full shadow-[0_0_50px_rgba(234,179,8,0.3)] scale-in-center">
            <div className="flex items-center gap-3 mb-6">
              <span className="material-symbols-outlined text-5xl text-yellow-500">warning</span>
              <h3 className="text-3xl font-headline text-white tracking-tight">{t.syncConflict}</h3>
            </div>

            <p className="text-text-light mb-8 text-sm leading-relaxed">
              {copy("This session has different cloud and local versions. Choose the version to keep:", "云端与本机的学习批次存在不同版本，请选择要保留的版本：")}
            </p>

            <div className="grid md:grid-cols-2 gap-6 mb-8">
              {/* 云端版本 */}
              <div
                onClick={() => setConflictChoice('cloud')}
                className={`cursor-pointer p-6 rounded-2xl border-2 transition-all ${
                  conflictChoice === 'cloud'
                    ? 'border-electric-blue bg-electric-blue/10'
                    : 'border-mid-charcoal hover:border-electric-blue/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-outlined text-electric-blue">cloud</span>
                  <h4 className="text-lg font-headline text-white">{copy("Cloud version","云端版本")}</h4>
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-text-light">
                    <span className="text-text-dark">{copy("Time: ","时间：")}</span>
                    {new Date(conflictModal.cloud.timestamp).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">{copy("Words: ","单词数：")}</span>
                    {conflictModal.cloud.wordCount}
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">{copy("Tag: ","标签：")}</span>
                    {conflictModal.cloud.libraryTag}
                  </p>
                </div>
              </div>

              {/* 本地版本 */}
              <div
                onClick={() => setConflictChoice('local')}
                className={`cursor-pointer p-6 rounded-2xl border-2 transition-all ${
                  conflictChoice === 'local'
                    ? 'border-electric-green bg-electric-green/10'
                    : 'border-mid-charcoal hover:border-electric-green/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-outlined text-electric-green">devices</span>
                  <h4 className="text-lg font-headline text-white">{copy("Local version","本地版本")}</h4>
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-text-light">
                    <span className="text-text-dark">{copy("Time: ","时间：")}</span>
                    {new Date(conflictModal.local.timestamp).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">{copy("Words: ","单词数：")}</span>
                    {conflictModal.local.wordCount}
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">{copy("Tag: ","标签：")}</span>
                    {conflictModal.local.libraryTag}
                  </p>
                </div>
              </div>
            </div>

            {/* 按钮组 */}
            <div className="flex gap-4">
              <button
                onClick={() => {
                  setConflictModal(null);
                  setConflictChoice(null);
                }}
                className="flex-1 py-4 rounded-xl bg-mid-charcoal text-text-light hover:bg-white hover:text-charcoal transition-all font-mono text-xs uppercase tracking-widest"
              >
                {copy("Cancel", "取消")}
              </button>
              <button
                onClick={handleConfirmConflictResolution}
                disabled={!conflictChoice}
                className="flex-1 py-4 rounded-xl bg-electric-green text-charcoal hover:bg-white transition-all font-headline text-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined">check_circle</span>
                {conflictChoice === 'cloud' ? copy('Use cloud version', '使用云端版本') : copy('Use local version', '使用本机版本')}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
          @keyframes breathe {
            0%, 100% { opacity: 0.3; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.2); }
          }
          @keyframes rotate-bg {
            0% { transform: translate(-50%, -50%) rotate(0deg); }
            100% { transform: translate(-50%, -50%) rotate(360deg); }
          }
          @keyframes champion-flip-out {
            from { transform: translateY(0); opacity: 1; }
            to   { transform: translateY(-110%); opacity: 0; }
          }
          @keyframes champion-flip-in {
            from { transform: translateY(110%); opacity: 0; }
            to   { transform: translateY(0); opacity: 1; }
          }
          @keyframes champion-glow {
            0%, 100% {
              box-shadow:
                0 0 0 1px rgba(0, 240, 255, 0.10),
                0 0 10px 0 rgba(0, 240, 255, 0.12);
            }
            50% {
              box-shadow:
                0 0 0 1px rgba(0, 240, 255, 0.35),
                0 0 22px 4px rgba(0, 240, 255, 0.38);
            }
          }
          .animate-champion-glow {
            animation: champion-glow 3s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .animate-champion-glow { animation: none; }
          }
          .animate-breathe {
            animation: breathe 8s ease-in-out infinite;
          }
          .animate-rotate-bg {
            animation: rotate-bg 30s linear infinite;
          }
        `}</style>

        {/* Background Decorations - Rotating Container */}
        <div className="fixed top-1/2 left-1/2 w-[150vw] h-[150vw] md:w-[120vmax] md:h-[120vmax] pointer-events-none animate-rotate-bg z-0">
            {/* Purple Blob - Top Left */}
            <div className="absolute top-[5%] left-[5%] w-[45%] h-[45%] bg-electric-purple/40 blur-[150px] rounded-full animate-breathe" />
            
            {/* Blue Blob - Bottom Right */}
            <div className="absolute bottom-[5%] right-[5%] w-[45%] h-[45%] bg-electric-blue/40 blur-[150px] rounded-full animate-breathe" style={{ animationDelay: '-4s' }} />
        </div>

      <header className="h-16 border-b border-mid-charcoal bg-dark-charcoal/80 backdrop-blur-md fixed top-0 left-0 right-0 z-50 px-6 flex items-center justify-between">
        <div className="relative flex items-center cursor-pointer" onClick={() => { setMode('DASHBOARD'); setEditingSessionId(null); setTestConfig(null); }}>
          <img
            src="/monsterImages/home-logo.webp"
            alt="Vocab Monster Logo"
            className="absolute left-0 top-1/3 w-12 h-12 object-contain -translate-y-[35%] z-20 pointer-events-none"
          />
          <h1 className="pl-16 font-headline text-3xl tracking-[0.02em] text-electric-blue">VOCAB MONSTER</h1>
        </div>
        <div className="hidden md:flex flex-1 justify-center px-4 min-w-0">
          <GlobalChampionBanner onOpen={() => { setHasOpenedGlobalLeaderboard(true); setShowGlobalLeaderboard(true); }} />
        </div>
        <div className="flex items-center gap-4">
          <CoinCounter balance={coinBalance} />
          <ReviewBadge count={dueWords.length} disabled={mode !== 'DASHBOARD'} anchorRef={reviewBadgeRef} onClick={() => {
            if (mode !== 'DASHBOARD' || !dailyRewardSettled || dailyLoginReward || pendingCoinReward || achievementQueue.length) return;
            reviewHistoryRef.current.markSeen(session.user.id, getShanghaiDateString());
            setReviewReminderOwner(session.user.id);
          }} />
          <div
            className="hidden sm:flex items-center gap-2 text-xs font-mono text-text-dark cursor-pointer hover:text-white transition-colors group"
            onClick={() => setShowAccountPanel(true)}
          >
            <span className="material-symbols-outlined text-sm group-hover:text-electric-blue transition-colors">cloud_done</span>
            <span className="group-hover:underline underline-offset-4">{session.user.email}</span>
          </div>
          <button onClick={handleLogout} className="p-2 text-text-light hover:text-red-400 transition-colors" title={copy("Log out", "退出登录")}>
            <span className="material-symbols-outlined">logout</span>
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-8 pt-20 md:pt-24 pb-12 md:pb-16 max-w-[1400px] mx-auto w-full relative z-10">
        {mode === 'DASHBOARD' && (
          <Dashboard
            stats={getStats()}
            sessions={visibleSessions}
            words={visibleWords}
            cachedImageDataUrls={cachedImageDataUrls}
            selectedSessionIds={selectedDashboardSessionIds}
            onToggleSessionSelect={(id) => {
                setSelectedDashboardSessionIds(prev => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                });
            }}
            onStartInput={() => {
                setEditingSessionId(null);
                setMode('INPUT');
            }}
            onStartTest={(ids) => handleStartTest(ids)}
            onStartEdit={handleStartEdit}
            onOpenLibrary={() => setMode('LIBRARY')}
            onQuickTest={() => setShowQuickTestModal(true)}
            onOpenGamePicker={() => setShowGamePickerModal(true)}
            onDeleteSessions={(ids) => {
                setIdsToDelete(ids);
                setShowDeleteConfirm(true);
            }}
            onManualSync={handleManualSync}
            syncingSessionId={syncingSessionId}
            highlightRecentSessions={highlightRecentSessions}
            onDismissRecentSessionsHighlight={() => setHighlightRecentSessions(false)}
            persistedUnlocks={unlockedAchievements}
          />
        )}
        {mode === 'INPUT' && (
          <InputMode 
            initialWords={editingSessionId ? visibleWords.filter(w => w.sessionId === editingSessionId) : undefined}
            currentLibrary={editingSessionId ? (sessions.find(s => s.id === editingSessionId)?.libraryTag || 'Custom') : 'Custom'}
            onComplete={handleSaveSession}
            onCancel={() => {
                setEditingSessionId(null);
                setMode('DASHBOARD');
            }}
            onDeleteWord={handleInputModeDeleteWord}
            allWords={visibleWords}
            cachedImageWordIds={cachedImageWordIds}
            cachedImageDataUrls={cachedImageDataUrls}
            onGenerateImageForWord={handleGenerateImageForWord}
          />
        )}
        {mode === 'TEST' && (
          testConfig?.kind === 'PUZZLE' ? (
            <PuzzleGameMode
              allWords={visibleWords}
              sessions={sessions}
              onComplete={async (summary: PuzzleGameSummary) => {
                await saveGameLearning(summary.roundId || `puzzle:${crypto.randomUUID()}`, summary.occurredAt || Date.now(), summary.results.map(result => ({
                  wordId: result.wordId,
                  status: result.status || (result.correct ? 'correct' : result.attemptsUsed > 0 ? 'incorrect' : 'unattempted'),
                  hintUsed: result.hintUsed, hadMistake: result.attemptsUsed > (result.correct ? 1 : 0),
                  durationMs: result.activatedAtMs != null && result.solvedAtMs != null ? result.solvedAtMs - result.activatedAtMs : null,
                })));
                if (!summary.rankingEligible || summary.rulesVersion) return;
                try {
                  const round: any = await recordPuzzleGameRound(summary);
                  const roundId = round?.round_id || round?.id;
                  if (roundId) {
                    const awarded = await awardPuzzleCoins(roundId, summary.totalScore);
                    if (awarded > 0) {
                      void refreshCoinBalance();
                      setPendingCoinReward({ amount: awarded, source: 'puzzle' });
                    } else {
                      showLocalizedNotification(`Puzzle score recorded: ${summary.totalScore} points`, `🧩 字谜成绩已记录：${summary.totalScore} 分`, 'success');
                    }
                  } else {
                    showLocalizedNotification(`Puzzle score recorded: ${summary.totalScore} points`, `🧩 字谜成绩已记录：${summary.totalScore} 分`, 'success');
                  }
                } catch (error) {
                  console.error('[PuzzleGameMode] Failed to record puzzle game round:', error);
                  showLocalizedNotification("Your puzzle score could not sync. The round results remain on this page.", "⚠️ 字谜成绩上传失败，但本局结果仍已保留在页面中。", 'warning');
                }
              }}
              onCancel={() => setMode('DASHBOARD')}
            />
          ) : (
            <TestModeV2
              key={session.user.id}
              allWords={visibleWords}
              sessions={sessions}
              initialSessionIds={testConfig?.sessionIds || []}
              initialWordIds={testConfig?.wordIds}
              onUpdateWord={handleLearningWordUpdate}
              onSaveComplete={updateLocalStats}
              onComplete={async (summary: CompletedTestSummary) => {
                try {
                  await updateLocalStats(summary);
                  if (authUserIdRef.current === session?.user?.id) setMode('DASHBOARD');
                } catch (error) {
                  console.error('[TestComplete] Local persistence failed:', error);
                  showLocalizedNotification("Test results have not been saved. Keep the results page open and try again.", "测试结果尚未保存，请保留结果页并重试。", 'error');
                }
              }}
              onCancel={() => setMode('DASHBOARD')}
            />
          )
        )}
        {mode === 'LIBRARY' && (
            <LibraryMode
                words={visibleWords}
                onClose={() => setMode('DASHBOARD')}
                onTest={handleStartTestFromLibrary}
                userId={session?.user?.id}
                onRefresh={refreshData}
            cachedImageWordIds={cachedImageWordIds}
            cachedImageDataUrls={cachedImageDataUrls}
            onGenerateImageForWord={handleGenerateImageForWord}
            />
        )}

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
                <div className="bg-light-charcoal border border-red-500/50 rounded-3xl p-8 max-w-md w-full shadow-[0_0_30px_rgba(239,68,68,0.2)] scale-in-center">
                    <div className="flex items-center gap-3 mb-4 text-red-500">
                        <span className="material-symbols-outlined text-4xl">{isDeleting ? 'delete_sweep' : 'warning'}</span>
                        <h3 className="text-2xl font-headline tracking-tight">
                            {isDeleting ? t.deleting : t.confirmDeletion}
                        </h3>
                    </div>
                    
                    {isDeleting ? (
                        // Progress View
                        <div className="space-y-4">
                            <div className="flex items-center gap-3">
                                <div className="w-6 h-6 border-2 border-electric-blue border-t-transparent rounded-full animate-spin"></div>
                                <p className="text-white font-mono text-sm">{deleteProgress?.message || 'Processing...'}</p>
                            </div>
                            
                            {/* Progress Steps */}
                            <div className="bg-dark-charcoal rounded-xl p-4 border border-mid-charcoal space-y-2">
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'fetching' ? 'text-electric-blue' : deleteProgress?.step && ['deleting-words', 'deleting-sessions', 'cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'fetching' ? 'pending' : deleteProgress?.step && ['deleting-words', 'deleting-sessions', 'cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    {t.preparing}
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'deleting-words' ? 'text-electric-blue' : deleteProgress?.step && ['deleting-sessions', 'cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'deleting-words' ? 'pending' : deleteProgress?.step && ['deleting-sessions', 'cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    {t.deletingWords}
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'deleting-sessions' ? 'text-electric-blue' : deleteProgress?.step && ['cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'deleting-sessions' ? 'pending' : deleteProgress?.step && ['cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    {t.deletingSessions}
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'cleaning-tags' ? 'text-electric-blue' : deleteProgress?.step === 'complete' ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'cleaning-tags' ? 'pending' : deleteProgress?.step === 'complete' ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    {t.cleaningTags}
                                </div>
                            </div>
                        </div>
                    ) : (
                        // Confirmation View
                        <>
                            <p className="text-white font-body mb-2">
                                {t.deleteConfirmText(idsToDelete.length)}
                            </p>
                            <p className="text-text-dark font-mono text-xs mb-8 p-4 bg-dark-charcoal rounded-xl border border-mid-charcoal">
                                {t.deleteWarning}
                            </p>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <button 
                                    onClick={() => {
                                        setShowDeleteConfirm(false);
                                        setIdsToDelete([]);
                                    }}
                                    className="bg-mid-charcoal hover:bg-white hover:text-charcoal text-text-light transition-all p-4 rounded-xl font-headline tracking-wider text-sm"
                                >
                                    {t.cancel}
                                </button>
                                <button 
                                    onClick={handleExecuteDelete}
                                    className="bg-red-500 hover:bg-red-600 text-white transition-all p-4 rounded-xl font-headline tracking-wider text-sm shadow-lg shadow-red-900/20"
                                >
                                    {t.deleteForever}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        )}

        {/* Quick Test Modal */}
        {showQuickTestModal && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
                <div className="bg-light-charcoal border border-mid-charcoal rounded-3xl p-8 max-w-md w-full shadow-2xl scale-in-center">
                    <h3 className="text-3xl font-headline text-white mb-2 tracking-tight"><HoverTranslationText text="CHOOSE TEST RANGE" translation="选择测试范围" /></h3>
                    <p className="text-text-dark font-body mb-8"><HoverTranslationText text="Select which words you want to practice right now." translation="选择你现在想练习的单词范围。" /></p>
                    
                    <div className="grid gap-4">
                        <button 
                            onClick={() => {
                                if (selectedDashboardSessionIds.size > 0) {
                                    handleStartTest(Array.from(selectedDashboardSessionIds));
                                    setShowQuickTestModal(false);
                                } else {
                              setShowQuickTestModal(false);
                              setMode('DASHBOARD');
                              setHighlightRecentSessions(true);
                                }
                            }}
                            className={`transition-all p-6 rounded-2xl flex flex-col items-start gap-1 group text-left ${
                                selectedDashboardSessionIds.size > 0 
                            ? 'bg-mid-charcoal hover:bg-electric-blue hover:text-charcoal' 
                            : 'bg-mid-charcoal/70 border border-dashed border-mid-charcoal hover:bg-electric-green hover:border-electric-green hover:text-charcoal hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(163,255,0,0.18)]'
                            }`}
                        >
                            <span className={`text-sm font-mono uppercase tracking-widest ${
                            selectedDashboardSessionIds.size > 0 ? 'text-electric-blue group-hover:text-charcoal' : 'text-text-dark group-hover:text-charcoal/80'
                            }`}>
                                <HoverTranslationText text="Option 1" translation="选项 1" />
                            </span>
                            <span className={`text-xl font-headline ${
                            selectedDashboardSessionIds.size > 0 ? 'group-hover:text-charcoal' : 'text-text-dark group-hover:text-charcoal'
                            }`}>
                                {selectedDashboardSessionIds.size > 0 ? <HoverTranslationText text={'TEST SELECTED (' + selectedDashboardSessionIds.size + ')'} translation="测试当前已选择的内容" /> : <HoverTranslationText text="RECENT SESSION" translation="最近的学习批次" />}
                            </span>
                            <span className={`text-xs font-body ${
                            selectedDashboardSessionIds.size > 0 ? 'opacity-50 group-hover:text-charcoal/70' : 'text-text-dark/60 group-hover:text-charcoal/70'
                            }`}>
                                {selectedDashboardSessionIds.size > 0 
                                    ? <HoverTranslationText text="Practice words from your current selection." translation="练习你当前选中的单词。" /> 
                                    : <HoverTranslationText text="Select one or more cards on the dashboard to test." translation="请先在仪表盘上选择一个或多个卡片再开始测试。" />
                                }
                            </span>
                        </button>

                        <button 
                            onClick={() => {
                                const allIds = visibleWords.map(w => w.id);
                                handleStartTestFromLibrary(allIds);
                                setShowQuickTestModal(false);
                            }}
                            className="bg-mid-charcoal hover:bg-electric-green hover:text-charcoal transition-all p-6 rounded-2xl flex flex-col items-start gap-1 group text-left"
                        >
                            <span className="text-sm font-mono text-electric-green group-hover:text-charcoal uppercase tracking-widest"><HoverTranslationText text="Option 2" translation="选项 2" /></span>
                            <span className="text-xl font-headline group-hover:text-charcoal"><HoverTranslationText text="ALL WORD LIBRARY" translation="全部词库" /></span>
                            <span className="text-xs opacity-50 font-body group-hover:text-charcoal/70"><HoverTranslationText text={`A comprehensive test of all ${visibleWords.length} words in your vault.`} translation={`对你词库中的全部 ${visibleWords.length} 个单词进行综合测试。`} /></span>
                        </button>

                        {/* Games have their own GAME MODE picker. */}

                        <button
                            onClick={() => setShowQuickTestModal(false)}
                            className="mt-4 text-text-dark hover:text-white transition-colors uppercase font-mono text-xs tracking-[0.2em]"
                        >
                            <HoverTranslationText text="Maybe Later" translation="稍后再说" />
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Game Mode Picker Modal */}
        {showGamePickerModal && (
            <GameModePickerModal
                visibleWords={visibleWords}
                onSelectPuzzle={() => { handleStartPuzzleGame(); setShowGamePickerModal(false); }}
                onClose={() => setShowGamePickerModal(false)}
            />
        )}
        
        {mode === 'DASHBOARD' && reviewReminderOwner === session.user.id && dueWords.length > 0 && !dailyLoginReward && !pendingCoinReward && (
          <DailyReviewReminder count={dueWords.length} anchorRef={reviewBadgeRef}
            onClose={() => { setReviewReminderOwner(null); reviewBadgeRef.current?.focus(); }}
            onStart={() => {
              setReviewReminderOwner(null);
              handleStartTestFromLibrary(adaptiveWordSelector.calculateQueue(visibleWords, dueWords, 12).map(word => word.id));
            }} />
        )}

        {/* Achievement Unlock Modal */}
        {!dailyLoginReward && !pendingCoinReward && !reviewPending && reviewReminderOwner !== session.user.id && achievementQueue.length > 0 && (
            <AchievementUnlockModal
                achievement={achievementQueue[0]}
                onClose={() => setAchievementQueue(prev => prev.slice(1))}
            />
        )}

        {/* Daily Login Reward Modal */}
        {dailyLoginReward && (
          <DailyLoginRewardModal
            reward={dailyLoginReward}
            onClose={() => setDailyLoginReward(null)}
          />
        )}

        {/* Coin Reward Popup (quiz / puzzle / achievement bonus) */}
        {!dailyLoginReward && pendingCoinReward && (
          <CoinRewardPopup
            amount={pendingCoinReward.amount}
            source={pendingCoinReward.source}
            onClose={() => {
              const nav = pendingCoinReward.navigateAfter;
              setPendingCoinReward(null);
              if (nav) setMode('DASHBOARD');
            }}
          />
        )}
      </main>

      <footer className="py-2 text-center text-text-dark text-[10px] border-t border-mid-charcoal bg-dark-charcoal/80 backdrop-blur-md fixed bottom-0 left-0 right-0 z-50">
        <p>{t.footerText}</p>
      </footer>

      {showAccountPanel && session && (
        <AccountPanel
          user={session.user}
          words={visibleWords}
          sessions={visibleSessions}
          dailyStats={dailyStats}
          persistedUnlocks={unlockedAchievements}
          onClose={() => setShowAccountPanel(false)}
          onLogout={() => {
              handleLogout();
              setShowAccountPanel(false);
          }}
        />
      )}
      {hasOpenedGlobalLeaderboard && (
        <div hidden={!showGlobalLeaderboard}>
          <GlobalLeaderboardModal
            open={showGlobalLeaderboard}
            onClose={() => setShowGlobalLeaderboard(false)}
          />
        </div>
      )}
      {showAdminConsole && (
        <AdminConsole 
          onClose={() => setShowAdminConsole(false)} 
          onDataChange={() => {
            // Re-fetch user data to reflect changes in images/words
            if (session?.user?.id) {
                setLoadingData(true);
                fetchUserData(session.user.id)
                    .then(({ words, sessions }) => {
                        setWords(words);
                        setSessions(sessions);
                    })
                    .finally(() => setLoadingData(false));
            }
          }}
        />
      )}
      {showPronunciationMaintenancePanel && (
        <PronunciationMaintenancePanel onClose={() => setShowPronunciationMaintenancePanel(false)} />
      )}
    </div>
  );
};

const isDragSelectionBlocked = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;

  return Boolean(target.closest('button, input, label, a, [data-no-drag-select="true"]'));
};

const useSessionDragSelection = (
  selectedIds: Set<string>,
  onToggleSelect: (id: string) => void,
) => {
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const dragModeRef = useRef<'select' | 'deselect' | null>(null);
  const dragSelectedIdsRef = useRef<Set<string>>(new Set(selectedIds));
  const visitedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    dragSelectedIdsRef.current = new Set(selectedIds);
  }, [selectedIds]);

  const stopDragSelection = useCallback(() => {
    setIsDraggingSelection(false);
    dragModeRef.current = null;
    visitedIdsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!isDraggingSelection) return;

    window.addEventListener('mouseup', stopDragSelection);
    window.addEventListener('blur', stopDragSelection);

    return () => {
      window.removeEventListener('mouseup', stopDragSelection);
      window.removeEventListener('blur', stopDragSelection);
    };
  }, [isDraggingSelection, stopDragSelection]);

  const applySelectionState = useCallback((id: string) => {
    const mode = dragModeRef.current;
    if (!mode || visitedIdsRef.current.has(id)) return;

    visitedIdsRef.current.add(id);

    const shouldSelect = mode === 'select';
    const nextSelectedIds = new Set(dragSelectedIdsRef.current);
    const isSelected = nextSelectedIds.has(id);

    if (isSelected === shouldSelect) return;

    onToggleSelect(id);

    if (shouldSelect) nextSelectedIds.add(id);
    else nextSelectedIds.delete(id);

    dragSelectedIdsRef.current = nextSelectedIds;
  }, [onToggleSelect]);

  const handleCardMouseDown = useCallback((event: React.MouseEvent<HTMLElement>, id: string) => {
    if (event.button !== 0 || isDragSelectionBlocked(event.target)) return;

    event.preventDefault();
    dragSelectedIdsRef.current = new Set(selectedIds);
    visitedIdsRef.current.clear();
    dragModeRef.current = dragSelectedIdsRef.current.has(id) ? 'deselect' : 'select';
    setIsDraggingSelection(true);
    applySelectionState(id);
  }, [applySelectionState, selectedIds]);

  const handleCardMouseEnter = useCallback((id: string) => {
    if (!isDraggingSelection) return;
    applySelectionState(id);
  }, [applySelectionState, isDraggingSelection]);

  return {
    isDraggingSelection,
    handleCardMouseDown,
    handleCardMouseEnter,
    stopDragSelection,
  };
};

// --- Session Matrix Component ---
const SessionMatrix: React.FC<{
  sessions: InputSession[],
  selectedIds: Set<string>,
  onToggleSelect: (id: string) => void,
  onStartTest: (id: string) => void,
  onEdit: (id: string) => void,
  onDelete: (id: string) => void,
  onExpand: () => void,
  onManualSync?: (id: string) => void,
  syncingSessionId?: string | null
}> = ({ sessions, selectedIds, onToggleSelect, onStartTest, onEdit, onDelete, onExpand, onManualSync, syncingSessionId }) => {
  const { isZh } = useLanguage();
  const tr = (en: string, zh: string) => isZh ? zh : en;
  const MAX_SLOTS = 12; // 2 rows x 6 cols
  const count = sessions.length;
  const showMoreButton = count > MAX_SLOTS;
  const { isDraggingSelection, handleCardMouseDown, handleCardMouseEnter } = useSessionDragSelection(selectedIds, onToggleSelect);
  
  const visibleCount = showMoreButton ? MAX_SLOTS - 1 : count;
  const visibleSessions = sessions.slice(0, visibleCount);
  const totalSlotsUsed = showMoreButton ? MAX_SLOTS : count;

  let gridClass = "grid-cols-1 grid-rows-1";
  if (totalSlotsUsed >= 2) gridClass = "grid-cols-1 md:grid-cols-2 grid-rows-1";
  if (totalSlotsUsed >= 3) gridClass = "grid-cols-1 md:grid-cols-3 grid-rows-1";
  if (totalSlotsUsed >= 4) gridClass = "grid-cols-2 md:grid-cols-2 grid-rows-2";
  if (totalSlotsUsed >= 5) gridClass = "grid-cols-2 md:grid-cols-3 grid-rows-2";
  if (totalSlotsUsed >= 7) gridClass = "grid-cols-2 md:grid-cols-4 grid-rows-2";
  if (totalSlotsUsed >= 9) gridClass = "grid-cols-3 md:grid-cols-5 grid-rows-2";
  if (totalSlotsUsed >= 11) gridClass = "grid-cols-3 md:grid-cols-6 grid-rows-2";

  const isHighDensity = totalSlotsUsed > 6;

  return (
    <div className={`grid gap-4 w-full h-full transition-all duration-700 ${gridClass} ${isDraggingSelection ? 'select-none cursor-crosshair' : ''}`}>
      {visibleSessions.map(s => (
        <div 
          key={s.id} 
          onMouseDown={(event) => handleCardMouseDown(event, s.id)}
          onMouseEnter={() => handleCardMouseEnter(s.id)}
          onDragStart={(event) => event.preventDefault()}
          className={`bg-light-charcoal rounded-xl border group transition-all flex flex-col overflow-hidden relative shadow-lg ${selectedIds.has(s.id) ? 'border-electric-green ring-1 ring-electric-green' : 'border-mid-charcoal hover:border-electric-blue'} ${isDraggingSelection ? 'cursor-crosshair' : ''}`}
        >
          {/* Library Banner at Top */}
          {s.libraryTag && s.libraryTag !== 'Custom' && (
            <div className={`w-full bg-gradient-to-r from-electric-blue/20 to-electric-blue/5 border-b border-electric-blue/30 flex items-center justify-center ${isHighDensity ? 'py-1' : 'py-1.5'}`}>
              <span className={`font-mono font-bold text-electric-blue uppercase tracking-widest ${isHighDensity ? 'text-[8px]' : 'text-[10px]'}`}>
                {s.libraryTag}
              </span>
            </div>
          )}
          
          {/* Main Content */}
          <div className={`flex flex-col justify-between flex-1 ${isHighDensity ? 'p-3' : 'p-6'}`}>
            <div className="flex justify-between items-start mb-2 z-10">
              <span className={`font-mono text-text-dark truncate ${isHighDensity ? 'text-[10px]' : 'text-xs'}`}>
                  {new Date(s.timestamp).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' })}
              </span>
              {/* CHECKBOX for Multi-Select */}
              <div className="flex items-center">
                  <input 
                      type="checkbox" 
                      checked={selectedIds.has(s.id)}
                      onChange={(e) => {
                          e.stopPropagation();
                          onToggleSelect(s.id);
                      }}
                      className="w-5 h-5 rounded border-mid-charcoal text-electric-green focus:ring-offset-0 focus:ring-0 bg-dark-charcoal cursor-pointer z-20"
                  />
              </div>
              </div>
            
            <div className="flex justify-between items-end z-10">
              <div data-no-drag-select="true" className="cursor-pointer" onClick={() => onEdit(s.id)} title={tr("Click to Edit Words", "点击编辑单词")}>
                <p className={`font-headline text-white group-hover:text-electric-blue leading-none transition-colors ${isHighDensity ? 'text-xl' : 'text-5xl'}`}>
                  {s.wordCount} <span className={`text-text-dark font-body font-normal ${isHighDensity ? 'text-[10px]' : 'text-sm'}`}>{tr("WORDS", "个词")}</span>
                </p>
                <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                   <span className="material-symbols-outlined text-[10px] text-electric-blue">edit</span>
                   <span className="text-[10px] text-electric-blue uppercase">{tr("Edit", "编辑")}</span>
                </div>
              </div>
              
              <button
                onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s.id);
                }}
                className={`bg-mid-charcoal rounded-lg text-text-dark hover:bg-red-500 hover:text-white transition-colors flex items-center justify-center z-20 ${isHighDensity ? 'p-1.5' : 'p-3'}`}
                title={tr("Delete Session", "删除学习批次")}
              >
                <span className={`material-symbols-outlined ${isHighDensity ? 'text-lg' : 'text-2xl'}`}>delete</span>
              </button>

              {/* ☁️ Cloud Sync Button */}
              {onManualSync && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onManualSync(s.id);
                  }}
                  disabled={syncingSessionId === s.id}
                  className={`rounded-lg transition-colors flex items-center justify-center z-20 ${isHighDensity ? 'p-1.5' : 'p-3'} ${
                    syncingSessionId === s.id
                      ? 'bg-electric-blue/20 text-electric-blue cursor-wait'
                      : 'bg-mid-charcoal text-text-dark hover:bg-electric-blue hover:text-white'
                  }`}
                  title={syncingSessionId === s.id ? tr('Syncing…', '正在同步…') : tr('Sync to cloud', '同步到云端')}
                >
                  <span className={`material-symbols-outlined ${syncingSessionId === s.id ? 'animate-spin' : ''} ${isHighDensity ? 'text-lg' : 'text-2xl'}`}>
                    {syncingSessionId === s.id ? 'refresh' : (
                      s.syncStatus === 'synced' ? 'check_box' :
                      s.syncStatus === 'pending' ? 'check_box_outline_blank' :
                      'error'
                    )}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {showMoreButton && (
        <button 
            onClick={onExpand}
            className="bg-mid-charcoal/30 hover:bg-mid-charcoal rounded-xl border-2 border-dashed border-mid-charcoal hover:border-electric-blue transition-all flex flex-col items-center justify-center gap-2 group"
        >
            <span className="material-symbols-outlined text-4xl text-text-dark group-hover:text-white transition-transform group-hover:scale-110">grid_view</span>
            <span className="font-headline text-xl text-text-dark group-hover:text-white">{count - visibleCount} {tr('MORE', '个更多批次')}</span>
        </button>
      )}
    </div>
  );
};

// --- Shared Image Preview Modal (fullscreen lightbox with prev/next + gallery strip) ---
interface PreviewItem {
  id: string;
  text: string;
  imageSrc: string;
  sessionId?: string;
}

const ImagePreviewModal: React.FC<{
  items: PreviewItem[];
  currentId: string | null;
  onChangeCurrentId: (id: string) => void;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}> = ({ items, currentId, onChangeCurrentId, onClose, onOpenSession }) => {
  const { isZh } = useLanguage();
  const tr = (en: string, zh: string) => isZh ? zh : en;
  const [scale, setScale] = useState(1);
  const galleryRef = useRef<HTMLDivElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);

  const currentIndex = currentId ? items.findIndex(it => it.id === currentId) : -1;
  const current = currentIndex !== -1 ? items[currentIndex] : null;
  const hasMultiple = items.length > 1;

  // 切换图片时重置缩放
  useEffect(() => {
    setScale(1);
  }, [currentId]);

  const navigate = useCallback((delta: number) => {
    if (currentIndex === -1 || items.length === 0) return;
    const len = items.length;
    const nextIdx = ((currentIndex + delta) % len + len) % len;
    onChangeCurrentId(items[nextIdx].id);
  }, [currentIndex, items, onChangeCurrentId]);

  // 键盘左右方向键切换上一张/下一张
  useEffect(() => {
    if (!current || !hasMultiple) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') navigate(-1);
      else if (e.key === 'ArrowRight') navigate(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [current, hasMultiple, navigate]);

  // 缩略图窗口：当前张前后各 5 张
  const galleryWindow = useMemo(() => {
    if (currentIndex === -1) return [] as PreviewItem[];
    const half = 5;
    const len = items.length;
    let start = currentIndex - half;
    let end = currentIndex + half + 1;
    if (start < 0) { end -= start; start = 0; }
    if (end > len) { start -= (end - len); end = len; }
    start = Math.max(0, start);
    return items.slice(start, end);
  }, [currentIndex, items]);

  // 自动将当前缩略图滚动到画廊中央（仅滚动画廊容器本身）
  useEffect(() => {
    const container = galleryRef.current;
    const thumb = activeThumbRef.current;
    if (!container || !thumb) return;
    const target = thumb.offsetLeft - container.clientWidth / 2 + thumb.clientWidth / 2;
    container.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [currentId, currentIndex]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.12 : -0.12;
    setScale(prev => Math.max(0.5, Math.min(4, Number((prev + delta).toFixed(2)))));
  };

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[220] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col items-center max-w-[calc(100vw-40px)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="relative rounded-2xl overflow-hidden border border-mid-charcoal"
          onWheel={handleWheel}
          title={tr("Scroll to zoom the picture", "可使用鼠标滚轮缩放图片")}
        >
          <img
            src={current.imageSrc}
            alt={current.text}
            className="block max-w-[calc(100vw-40px)] max-h-[calc(100vh-260px)] w-auto h-auto transition-transform duration-150"
            style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
          />

          {onOpenSession && current.sessionId && (
            <div className="absolute left-3 top-3 flex items-center gap-2">
              <button
                onClick={() => onOpenSession(current.sessionId!)}
                className="px-3 py-1.5 rounded-lg bg-electric-blue text-charcoal hover:bg-white transition-colors text-xs font-headline"
              >
                {tr('Open source session', '打开所属学习批次')}
              </button>
            </div>
          )}

          <div className="absolute right-3 top-3 flex items-center gap-2">
            {hasMultiple && (
              <span className="px-2 py-1 rounded-md bg-black/45 text-white font-mono text-[10px]">
                {currentIndex + 1} / {items.length}
              </span>
            )}
            <span className="px-2 py-1 rounded-md bg-black/45 text-white font-mono text-[10px]">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg bg-black/45 text-text-light hover:bg-red-500 hover:text-white transition-colors flex items-center justify-center"
              title={tr("Close preview", "关闭预览")}
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>

          <div className="absolute left-0 right-0 bottom-0 px-4 py-3 bg-gradient-to-t from-black/75 to-transparent">
            <p className="text-[10px] font-mono text-electric-blue uppercase tracking-[0.2em]">{tr("Image Preview", "图片预览")}</p>
            <p className="text-white font-serif text-lg truncate">{current.text}</p>
          </div>
        </div>

        {/* Gallery 缩略图陈列：当前张前后各 5 张，可点击跳转；两侧箭头一次跳 10 张 */}
        {hasMultiple && (
          <div className="mt-3 flex items-center justify-center gap-2 max-w-[calc(100vw-40px)]">
            <button
              onClick={(event) => { event.stopPropagation(); navigate(-10); }}
              className="shrink-0 w-8 h-8 rounded-full bg-black/45 text-white hover:bg-black/65 hover:scale-110 transition-all flex items-center justify-center"
              title={tr("Previous 10 pictures", "向前 10 张")}
            >
              <span className="material-symbols-outlined text-lg">keyboard_double_arrow_left</span>
            </button>
            <div
              ref={galleryRef}
              className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-[calc(100vw-140px)]"
            >
              {galleryWindow.map((it) => {
                const active = it.id === currentId;
                return (
                  <button
                    key={it.id}
                    ref={active ? activeThumbRef : null}
                    onClick={() => onChangeCurrentId(it.id)}
                    title={it.text}
                    className={`relative shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 transition-all ${active ? 'border-electric-blue ring-2 ring-electric-blue/40 scale-105' : 'border-transparent opacity-60 hover:opacity-100'}`}
                  >
                    <img src={it.imageSrc} alt={it.text} className="w-full h-full object-cover" />
                  </button>
                );
              })}
            </div>
            <button
              onClick={(event) => { event.stopPropagation(); navigate(10); }}
              className="shrink-0 w-8 h-8 rounded-full bg-black/45 text-white hover:bg-black/65 hover:scale-110 transition-all flex items-center justify-center"
              title={tr("Next 10 pictures", "向后 10 张")}
            >
              <span className="material-symbols-outlined text-lg">keyboard_double_arrow_right</span>
            </button>
          </div>
        )}
      </div>

      {hasMultiple && (
        <>
          <button
            onClick={(event) => {
              event.stopPropagation();
              navigate(-1);
            }}
            className="absolute left-3 md:left-6 top-1/2 -translate-y-1/2 z-30 w-11 h-11 rounded-full bg-black/45 text-white hover:bg-black/65 hover:scale-110 transition-all flex items-center justify-center"
            title={tr("Previous picture (←)", "上一张（←）")}
          >
            <span className="material-symbols-outlined text-xl">chevron_left</span>
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              navigate(1);
            }}
            className="absolute right-3 md:right-6 top-1/2 -translate-y-1/2 z-30 w-11 h-11 rounded-full bg-black/45 text-white hover:bg-black/65 hover:scale-110 transition-all flex items-center justify-center"
            title={tr("Next picture (→)", "下一张（→）")}
          >
            <span className="material-symbols-outlined text-xl">chevron_right</span>
          </button>
        </>
      )}
    </div>
  );
};

// --- Dashboard Component ---
const Dashboard: React.FC<{
  stats: Record<string, DayStats>,
  sessions: InputSession[],
  words: WordEntry[],
  cachedImageDataUrls?: Record<string, string>;
  selectedSessionIds: Set<string>,
  onToggleSessionSelect: (id: string) => void,
  onStartInput: () => void,
  onStartTest: (sIds: string[]) => void,
  onStartEdit: (sId: string) => void,
  onOpenLibrary: () => void,
  onQuickTest: () => void,
  onOpenGamePicker: () => void,
  onDeleteSessions: (ids: string[]) => void,
  onManualSync?: (id: string) => void,
  syncingSessionId?: string | null,
  highlightRecentSessions?: boolean,
  onDismissRecentSessionsHighlight?: () => void,
  persistedUnlocks?: Set<string>,
}> = ({ stats, sessions, words, cachedImageDataUrls = {}, selectedSessionIds, onToggleSessionSelect, onStartInput, onStartTest, onStartEdit, onOpenLibrary, onQuickTest, onOpenGamePicker, onDeleteSessions, onManualSync, syncingSessionId, highlightRecentSessions = false, onDismissRecentSessionsHighlight, persistedUnlocks }) => {
  const { isZh } = useLanguage();
  const tr = (en: string, zh: string) => isZh ? zh : en;
  const t = useT();
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [previewImage, setPreviewImage] = useState<{ id: string; text: string; imageSrc: string; sessionId: string } | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const recentSessionsRef = useRef<HTMLDivElement>(null);
  const {
    isDraggingSelection: isDraggingListSelection,
    handleCardMouseDown: handleListCardMouseDown,
    handleCardMouseEnter: handleListCardMouseEnter,
  } = useSessionDragSelection(selectedSessionIds, onToggleSessionSelect);

  const wordsWithImages = useMemo(() => {
    return words
      .map((word) => {
        const src = word.image_url || cachedImageDataUrls[word.id] || null;
        if (!src) return null;
        return {
          id: word.id,
          text: word.text,
          imageSrc: src,
          sessionId: word.sessionId,
        };
      })
      .filter(Boolean) as { id: string; text: string; imageSrc: string; sessionId: string }[];
  }, [words, cachedImageDataUrls]);

  // 1. Auto-rotation logic (5 seconds)
  useEffect(() => {
    if (wordsWithImages.length <= 1) return;

    const timer = setInterval(() => {
      setCarouselIndex(prev => (prev + 1) % wordsWithImages.length);
    }, 5000);

    return () => clearInterval(timer);
  }, [wordsWithImages.length]);

  // Reset index if it goes out of sync with library updates
  useEffect(() => {
    if (carouselIndex >= wordsWithImages.length && wordsWithImages.length > 0) {
      setCarouselIndex(0);
    }
  }, [wordsWithImages.length, carouselIndex]);

  useEffect(() => {
    if (!highlightRecentSessions) return;

    setShowAllSessions(false);

    const timer = window.setTimeout(() => {
      recentSessionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [highlightRecentSessions]);

  const totalCorrect = Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.correct, 0);
  const totalAll = Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.total, 0);
  const accuracy = (totalAll as number) > 0 ? ((totalCorrect as number) / (totalAll as number)) * 100 : 0;

  const openPreview = (item: { id: string; text: string; imageSrc: string; sessionId: string }) => {
    setPreviewImage(item);
  };

  const closePreview = () => {
    setPreviewImage(null);
  };

  const handlePreviewChangeCurrentId = (id: string) => {
    const next = wordsWithImages.find(w => w.id === id);
    if (next) setPreviewImage(next);
  };

  const handlePreviewOpenSession = (sessionId: string) => {
    closePreview();
    onStartEdit(sessionId);
  };

  return (
    <div className="relative grid lg:grid-cols-12 gap-8 items-stretch animate-in fade-in slide-in-from-bottom-4 duration-700">
      <ImagePreviewModal
        items={wordsWithImages}
        currentId={previewImage?.id ?? null}
        onChangeCurrentId={handlePreviewChangeCurrentId}
        onClose={closePreview}
        onOpenSession={handlePreviewOpenSession}
      />


      {highlightRecentSessions && (
        <div
          className="fixed inset-0 z-30 bg-black/75 backdrop-blur-[2px] animate-in fade-in duration-300"
          onClick={onDismissRecentSessionsHighlight}
          aria-hidden="true"
        />
      )}
      <div className="lg:col-span-8 flex flex-col gap-10">
        <div className="flex flex-col md:flex-row items-center gap-10">
          
          <div className="w-full md:w-80 h-80 flex-shrink-0 relative group order-last md:order-first">
            <div className="absolute -inset-1 bg-gradient-to-r from-electric-blue to-electric-purple rounded-3xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative w-full h-full bg-light-charcoal rounded-3xl border border-mid-charcoal overflow-hidden flex flex-col items-center justify-center">
              {wordsWithImages.length > 0 ? (
                <>
                  <div className="relative w-full h-full overflow-hidden">
                    <div
                      className="flex w-full h-full transition-transform duration-700 ease-out"
                      style={{ transform: `translateX(-${carouselIndex * 100}%)` }}
                    >
                      {wordsWithImages.map((item) => (
                        <button
                          key={item.id}
                          className="relative w-full h-full shrink-0 text-left"
                          onClick={() => openPreview(item)}
                          title={tr("Preview picture (right-click to save)", "点击预览大图（可右键保存）")}
                        >
                          <img
                            src={item.imageSrc}
                            alt={item.text}
                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-dark-charcoal via-transparent to-transparent opacity-80 shadow-[inset_0_-40px_60px_rgba(0,0,0,0.5)]"></div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {wordsWithImages.length > 1 && (
                    <>
                      <button
                        onClick={() => setCarouselIndex(prev => (prev - 1 + wordsWithImages.length) % wordsWithImages.length)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/45 text-white hover:bg-black/65 transition-colors flex items-center justify-center"
                        title={tr("Previous picture", "上一张")}
                      >
                        <span className="material-symbols-outlined text-base">chevron_left</span>
                      </button>
                      <button
                        onClick={() => setCarouselIndex(prev => (prev + 1) % wordsWithImages.length)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/45 text-white hover:bg-black/65 transition-colors flex items-center justify-center"
                        title={tr("Next picture", "下一张")}
                      >
                        <span className="material-symbols-outlined text-base">chevron_right</span>
                      </button>
                    </>
                  )}

                  <div className="absolute bottom-4 left-4 right-4 z-10 animate-in slide-in-from-bottom-2 fade-in duration-700 delay-150 pointer-events-none">
                    <p className="text-[10px] font-mono text-electric-blue uppercase tracking-[0.2em] mb-1 drop-shadow-sm">{tr("Featured", "精选单词")}</p>
                    <p className="font-serif text-2xl text-white italic capitalize drop-shadow-lg">{wordsWithImages[carouselIndex].text}</p>
                    {wordsWithImages.length > 1 && (
                      <div className="flex gap-1 mt-3 pointer-events-auto">
                          {wordsWithImages.map((_, idx) => (
                              <button
                                key={idx}
                                onClick={() => setCarouselIndex(idx)}
                                className={`h-1 rounded-full transition-all duration-500 ${idx === carouselIndex ? 'w-4 bg-electric-blue' : 'w-1 bg-white/20 hover:bg-white/40'}`}
                                title={tr(`Show picture ${idx + 1}`, `切换到第 ${idx + 1} 张`)}
                              />
                          ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="w-full h-full relative animate-in fade-in duration-700">
                  <img src="/publicImages/ALL.webp" alt={tr("Welcome", "欢迎")} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark-charcoal via-transparent to-transparent opacity-80"></div>
                </div>
              )}
            </div>
          </div>

          <div 
            className="text-center md:text-left flex-1 order-first md:order-last relative"
            style={{
              backgroundImage: `url(/monsterImages/M${new Date().getDay()}.webp)`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right top',
              backgroundSize: 'auto 65%',
            }}
          >
            <h2 className="text-7xl sm:text-9xl font-headline text-electric-blue leading-tight mb-4 relative z-10">
              VOCAB<br/>MONSTER
            </h2>
            <p className="text-xl text-text-dark max-w-xl md:ml-auto relative z-10">{t.dashboardDesc}</p>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-4 md:gap-6">
          <button
            onClick={onStartInput}
            className="flex-1 bg-mid-charcoal border-2 border-electric-green text-electric-green font-headline text-2xl md:text-3xl py-7 md:py-8 px-6 md:px-10 rounded-2xl hover:bg-electric-green hover:text-charcoal transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-4"
          >
            <span className="material-symbols-outlined text-4xl">add_circle</span>
            {t.addWords}
          </button>

          {selectedSessionIds.size > 0 ? (
             <button
                onClick={() => onStartTest(Array.from(selectedSessionIds))}
                className="flex-1 bg-electric-blue text-charcoal font-headline text-2xl md:text-3xl py-7 md:py-8 px-6 md:px-10 rounded-2xl hover:bg-white transition-all transform hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,240,255,0.4)] flex items-center justify-center gap-4 animate-in fade-in"
             >
                <span className="material-symbols-outlined text-4xl">checklist</span>
                {t.testSelected(selectedSessionIds.size)}
             </button>
          ) : (
             <button
                className="flex-1 bg-electric-green text-charcoal font-headline text-2xl md:text-3xl py-7 md:py-8 px-6 md:px-10 rounded-2xl hover:bg-electric-blue transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-4"
                onClick={() => (sessions && sessions.length > 0) ? onQuickTest() : onStartInput()}
             >
                <span className="material-symbols-outlined text-4xl">play_arrow</span>
                {t.quickTest}
             </button>
          )}

          <button
            onClick={onOpenGamePicker}
            className="flex-1 bg-mid-charcoal border-2 border-electric-purple text-electric-purple font-headline text-2xl md:text-3xl py-7 md:py-8 px-6 md:px-10 rounded-2xl hover:bg-electric-purple hover:text-white transition-all transform hover:-translate-y-1 hover:shadow-[0_0_25px_rgba(187,0,255,0.35)] flex items-center justify-center gap-4"
          >
            <span className="material-symbols-outlined text-4xl">sports_esports</span>
            {t.gameMode}
          </button>
        </div>

        {/* Adaptive Session Matrix Section */}
        <div
          ref={recentSessionsRef}
          className={`space-y-4 relative ${highlightRecentSessions ? 'z-40 rounded-[2rem] bg-dark-charcoal/20 p-4 ring-2 ring-electric-green/80 shadow-[0_0_0_1px_rgba(163,255,0,0.12),0_0_35px_rgba(163,255,0,0.28)]' : ''}`}
        >
          {highlightRecentSessions && (
            <div className="absolute -top-5 left-4 z-50 inline-flex items-center gap-2 rounded-full bg-electric-green px-4 py-2 text-[11px] font-mono uppercase tracking-[0.22em] text-charcoal shadow-2xl">
              <span className="material-symbols-outlined text-sm">ads_click</span>
              <HoverTranslationText text="Select session cards here" translation="请在这里选择要测试的学习卡片" />
            </div>
          )}
          <div className="flex justify-between items-end border-b border-mid-charcoal pb-2">
            <h3 className="font-headline text-2xl text-text-light tracking-widest"><HoverTranslationText text="RECENT SESSIONS" translation="最近的学习批次" /></h3>
            <div className="flex items-center gap-4">
            {highlightRecentSessions && (
              <>
                <button
                  onClick={() => {
                    if (selectedSessionIds.size === 0) return;
                    onDismissRecentSessionsHighlight?.();
                    onStartTest(Array.from(selectedSessionIds));
                  }}
                  disabled={selectedSessionIds.size === 0}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-[11px] font-mono uppercase tracking-[0.2em] transition-all ${
                    selectedSessionIds.size > 0
                      ? 'bg-electric-green text-charcoal hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(163,255,0,0.28)]'
                      : 'bg-mid-charcoal text-text-dark cursor-not-allowed opacity-70'
                  }`}
                >
                  <span className="material-symbols-outlined text-sm">play_arrow</span>
                  <HoverTranslationText
                    text={selectedSessionIds.size > 0 ? `START TEST (${selectedSessionIds.size})` : 'SELECT A SESSION'}
                    translation={selectedSessionIds.size > 0 ? `开始测试（${selectedSessionIds.size}）` : '请先选择学习批次'}
                  />
                </button>
                <button
                  onClick={onDismissRecentSessionsHighlight}
                  className="text-xs font-mono text-text-dark hover:text-white uppercase transition-colors"
                >
                  <HoverTranslationText text="Dismiss" translation="关闭引导" />
                </button>
              </>
            )}
                {showAllSessions && selectedSessionIds.size > 0 && (
                    <button
                        onClick={() => onDeleteSessions(Array.from(selectedSessionIds))}
                        className="text-xs font-mono text-red-500 hover:text-red-400 uppercase flex items-center gap-1 transition-colors"
                    >
                        <span className="material-symbols-outlined text-sm">delete</span>
                        <HoverTranslationText text={`DELETE (${selectedSessionIds.size})`} translation={`删除（${selectedSessionIds.size}）`} />
                    </button>
                )}
                {showAllSessions ? (
                    <button onClick={() => setShowAllSessions(false)} className="text-xs font-mono text-electric-blue hover:text-white uppercase">
                        <HoverTranslationText text="Back to Matrix" translation="返回矩阵视图" />
                    </button>
                ) : (
                    sessions.length > 0 && <span className="text-xs font-mono text-text-dark opacity-50"><HoverTranslationText text={`${sessions.length} TOTAL`} translation={`共 ${sessions.length} 个`} /></span>
                )}
            </div>
          </div>

          <div className="bg-dark-charcoal/50 p-1 rounded-2xl border border-mid-charcoal/30">
            {sessions.length === 0 ? (
                <div className="p-12 border-2 border-dashed border-mid-charcoal rounded-xl text-center text-text-dark h-96 flex flex-col items-center justify-center">
                    <span className="material-symbols-outlined text-6xl opacity-20 mb-4">layers_clear</span>
                    <p><HoverTranslationText text="No sessions yet. Start by adding some words!" translation="还没有学习批次，先添加一些单词开始吧！" /></p>
                </div>
            ) : showAllSessions ? (
                /* Full List View */
              <div className={`grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 h-96 overflow-y-auto p-4 custom-scrollbar ${isDraggingListSelection ? 'select-none cursor-crosshair' : ''}`}>
                    {sessions.map(s => (
                  <div
                    key={s.id}
                    onMouseDown={(event) => handleListCardMouseDown(event, s.id)}
                    onMouseEnter={() => handleListCardMouseEnter(s.id)}
                    onDragStart={(event) => event.preventDefault()}
                    className={`bg-light-charcoal p-4 rounded-xl border flex justify-between items-center group transition-all ${selectedSessionIds.has(s.id) ? 'border-electric-green' : 'border-mid-charcoal hover:border-text-light'} ${isDraggingListSelection ? 'cursor-crosshair' : ''}`}
                  >
                             <div className="flex items-center gap-3">
                                <input 
                                    type="checkbox" 
                                    checked={selectedSessionIds.has(s.id)}
                                    onChange={() => onToggleSessionSelect(s.id)}
                                    className="w-4 h-4 rounded border-mid-charcoal text-electric-green bg-dark-charcoal cursor-pointer"
                                />
                      <div data-no-drag-select="true" onClick={() => onStartEdit(s.id)} className="cursor-pointer">
                                    <p className="text-xs font-mono text-text-dark mb-1">{new Date(s.timestamp).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}</p>
                                    <p className="font-headline text-2xl text-white group-hover:text-electric-blue">{t.wordsUnit(s.wordCount)}</p>
                                </div>
                             </div>
                             <div className="flex gap-2">
                                {/* ☁️ Cloud Sync Button */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    // Sync will be handled by parent
                                  }}
                                  disabled={syncingSessionId === s.id}
                                  className={`p-2 rounded-lg transition-colors ${
                                    syncingSessionId === s.id
                                      ? 'bg-electric-blue/20 text-electric-blue cursor-wait'
                                      : 'bg-mid-charcoal text-text-dark hover:bg-electric-blue hover:text-white'
                                  }`}
                                  title={syncingSessionId === s.id ? tr('Syncing…', '正在同步…') : tr('Sync to cloud', '同步到云端')}
                                >
                                  <span className={`material-symbols-outlined text-lg ${syncingSessionId === s.id ? 'animate-spin' : ''}`}>
                                    {syncingSessionId === s.id ? 'refresh' : (
                                      s.syncStatus === 'synced' ? 'check_box' :
                                      s.syncStatus === 'pending' ? 'check_box_outline_blank' :
                                      'error'
                                    )}
                                  </span>
                                </button>

                                <button onClick={() => onStartEdit(s.id)} className="p-2 bg-mid-charcoal rounded-lg text-text-light hover:text-electric-blue transition-colors" title={tr("Edit", "编辑")}>
                                    <span className="material-symbols-outlined text-lg">edit</span>
                                </button>
                                <button onClick={() => onDeleteSessions([s.id])} className="p-2 bg-mid-charcoal rounded-lg text-text-dark hover:bg-red-500 hover:text-white transition-colors" title={tr("Delete", "删除")}>
                                    <span className="material-symbols-outlined text-lg">delete</span>
                                </button>
                             </div>
                        </div>
                    ))}
                </div>
            ) : (
                /* Adaptive Matrix View */
                <div className="h-96 w-full p-2">
                    <SessionMatrix
                        sessions={sessions}
                        selectedIds={selectedSessionIds}
                        onToggleSelect={onToggleSessionSelect}
                        onStartTest={(id) => onStartTest([id])}
                        onEdit={onStartEdit}
                        onDelete={(id) => onDeleteSessions([id])}
                        onExpand={() => setShowAllSessions(true)}
                        onManualSync={onManualSync}
                        syncingSessionId={syncingSessionId}
                    />
                </div>
            )}
          </div>
        </div>

        {/* Word Library Section */}
        <div className="space-y-4">
          <div className="flex justify-between items-end border-b border-mid-charcoal pb-2">
            <h3 className="font-headline text-2xl text-text-light tracking-widest"><HoverTranslationText text="WORD LIBRARY" translation="单词库" /></h3>
            <div className="flex items-center gap-4">
              <span className="text-xs font-mono text-text-dark opacity-50">{t.wordsUnit(words.length)}</span>
            </div>
          </div>

          <div
            onClick={onOpenLibrary}
            className="bg-light-charcoal py-4 px-6 rounded-2xl border border-mid-charcoal group hover:border-electric-blue cursor-pointer transition-all relative overflow-hidden flex flex-col justify-center min-h-[130px]"
          >
            <p className="text-text-dark text-[10px] mb-3 relative z-10 opacity-70"><HoverTranslationText text="Browse and manage your full collection alphabetically." translation="按字母顺序浏览并管理你的全部单词收藏。" /></p>

            <div className="flex items-center justify-between relative z-10 pr-1">
              <div className="flex items-center gap-3">
                <div className="bg-dark-charcoal p-1.5 rounded-lg border border-mid-charcoal group-hover:border-electric-blue/50 transition-colors">
                  <span className="font-mono text-electric-blue font-bold text-lg">{words.length}</span>
                </div>
                <span className="font-mono text-[9px] text-text-dark uppercase tracking-tighter"><HoverTranslationText text="Total Entries" translation="总条目数" /></span>
              </div>
              <div className="bg-electric-blue/20 p-1 rounded-full text-electric-blue group-hover:bg-electric-blue group-hover:text-charcoal transition-all">
                <span className="material-symbols-outlined text-xl">arrow_forward</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="lg:col-span-4 flex flex-col gap-4">
        <CalendarView stats={stats} />

        <LeaderboardPanel stats={stats} words={words} />

        <AchievementsPanel words={words} sessions={sessions} dailyStats={stats} persistedUnlocks={persistedUnlocks} className="flex-1" />
      </div>
    </div>
  );
};

// --- Library Mode Component ---
const LibraryMode: React.FC<{
    words: WordEntry[];
    onClose: () => void;
    onTest: (ids: string[]) => void;
    userId?: string;
    onRefresh?: () => void;
  cachedImageWordIds?: Set<string>;
  cachedImageDataUrls?: Record<string, string>;
  onGenerateImageForWord?: (word: { id: string; text: string; language?: string | null; hasExistingImage?: boolean }) => Promise<boolean>;
}> = ({ words, onClose, onTest, userId, onRefresh, cachedImageWordIds = new Set(), cachedImageDataUrls = {}, onGenerateImageForWord }) => {
  const { isZh } = useLanguage();
  const tr = (en: string, zh: string) => isZh ? zh : en;
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [generatingWordIds, setGeneratingWordIds] = useState<Set<string>>(new Set());

    // 带图单词列表，用于全屏预览与缩略图导航
    const libraryItems = useMemo(() => {
      return words
        .map((word) => {
          const src = word.image_url || cachedImageDataUrls[word.id] || null;
          if (!src) return null;
          return { id: word.id, text: word.text, imageSrc: src, sessionId: word.sessionId };
        })
        .filter(Boolean) as { id: string; text: string; imageSrc: string; sessionId: string }[];
    }, [words, cachedImageDataUrls]);

    // Helper function to determine error severity level
    // 辅助函数：确定错误严重度等级
    const getErrorSeverity = (errorCount: number): {
        level: 'none' | 'low' | 'medium' | 'high' | 'critical'
        color: string
        label: string
        icon: string
    } => {
        if (errorCount === 0) return {
            level: 'none',
            color: 'text-electric-green',
            label: tr('Perfect', '无错误'),
            icon: 'check_circle'
        }
        if (errorCount < 0.5) return {
            level: 'low',
            color: 'text-yellow-400',
            label: tr('Minor', '轻微'),
            icon: 'info'
        }
        if (errorCount < 1.0) return {
            level: 'medium',
            color: 'text-orange-400',
            label: tr('Moderate', '中等'),
            icon: 'warning'
        }
        if (errorCount < 2.0) return {
            level: 'high',
            color: 'text-red-400',
            label: tr('Severe', '严重'),
            icon: 'error'
        }
        return {
            level: 'critical',
            color: 'text-red-600',
            label: tr('Critical', '高风险'),
            icon: 'dangerous'
        }
    };
    
    // Persist library selection to localStorage
    const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(() => {
        try {
            const saved = localStorage.getItem('vibe-word-master-selected-libraries');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    // 如果保存的选择中没有 'All'，强制添加 'All'
                    // 确保用户看到所有单词
                    const libSet = new Set(parsed);
                    if (!libSet.has('All')) {
                        console.log('[LibraryMode] Auto-upgrading to show all words');
                        return new Set(['All']);
                    }
                    return libSet;
                }
            }
        } catch (e) {
            console.error('Failed to load saved library selection:', e);
        }
        // 默认选择 'All'，显示所有单词
        return new Set(['All']);
    });

    // Save library selection whenever it changes
    useEffect(() => {
        try {
            localStorage.setItem('vibe-word-master-selected-libraries', JSON.stringify(Array.from(selectedLibraries)));
        } catch (e) {
            console.error('Failed to save library selection:', e);
        }
    }, [selectedLibraries]);

    const [searchTerm, setSearchTerm] = useState('');
    const [randomCount, setRandomCount] = useState<string>('10');
    const [isMouseDown, setIsMouseDown] = useState(false);
    const [playingPreviewWordId, setPlayingPreviewWordId] = useState<string | null>(null);

    // 字母点击自动滚动定位：每个字母分组节点的 ref 映射（'#' 作为 key 也合法）
    const letterSectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
    // 区分"纯点击"与"拖拽"：记录本次按下的起始字母 + 是否已发生拖拽
    const pressStateRef = useRef<{ letter: string; moved: boolean } | null>(null);
    const scrollToLetter = (letter: string) => {
        const el = letterSectionRefs.current[letter];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // Advanced Filter States
    // 高级过滤状态
    const [filterMistakeOnly, setFilterMistakeOnly] = useState(false);
    const [filterMinErrorCount, setFilterMinErrorCount] = useState<number | null>(null);
    const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

    // Derived Libraries Option List
    const availableLibraries = useMemo(() => {
        const libs = new Set<string>();
        libs.add('All');
        libs.add('Custom'); // Always present
        words.forEach(w => w.tags?.forEach(t => libs.add(t)));
        return Array.from(libs).sort(); 
    }, [words]);

    // Apply Filter based on Library Selection
    const libraryFilteredWords = useMemo(() => {
         if (selectedLibraries.has('All')) return words;
         return words.filter(w => {
             const tags = w.tags && w.tags.length > 0 ? w.tags : ['Custom'];
             return tags.some(t => selectedLibraries.has(t));
         });
    }, [words, selectedLibraries]);

    const sortedWords = useMemo(() => {
        return [...libraryFilteredWords].sort((a, b) => a.text.localeCompare(b.text));
    }, [libraryFilteredWords]);

    const filteredWords = useMemo(() => {
        let result = sortedWords.filter((w: WordEntry) => w.text.toLowerCase().includes(searchTerm.toLowerCase()));

        // Apply Mistake Bank filter
        // 应用错词库过滤
        if (filterMistakeOnly) {
            result = result.filter(w => w.tags?.includes('Mistake'));
        }

        // Apply minimum error count filter
        // 应用最小错误计数过滤
        if (filterMinErrorCount !== null) {
            result = result.filter(w => w.error_count >= filterMinErrorCount);
        }

        console.log('[LibraryMode] Filter stats:', {
            totalWords: words.length,
            libraryFiltered: libraryFilteredWords.length,
            sortedWords: sortedWords.length,
            searchTerm: searchTerm || '(empty)',
            mistakeOnly: filterMistakeOnly,
            minErrorCount: filterMinErrorCount,
            filteredWords: result.length
        });
        return result;
    }, [sortedWords, searchTerm, words.length, libraryFilteredWords.length, filterMistakeOnly, filterMinErrorCount]);

    // Group by letter
    const grouped = useMemo(() => {
        const groups: Record<string, WordEntry[]> = {};
        filteredWords.forEach(w => {
            const letter = w.text.charAt(0).toUpperCase();
            // Handle non-alphabetic chars
            const key = /^[A-Z]$/.test(letter) ? letter : '#';
            if (!groups[key]) groups[key] = [];
            groups[key].push(w);
        });
        return groups;
    }, [filteredWords]);

    const alphabet = useMemo(() => {
        const alpha = [];
        for (let i = 65; i <= 90; i++) alpha.push(String.fromCharCode(i));
        alpha.push('#');
        return alpha;
    }, []);

    const toggleSelection = (id: string) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedIds(newSet);
    };

    const toggleLetterGroup = (letter: string, forceState?: boolean) => {
        const groupWords = grouped[letter] || [];
        if (groupWords.length === 0) return;

        const groupIds = groupWords.map(w => w.id);
        const allSelected = groupIds.every(id => selectedIds.has(id));
        
        const newSet = new Set(selectedIds);
        
        // If forceState is provided, use it. Otherwise toggle.
        const shouldSelect = forceState !== undefined ? forceState : !allSelected;

        if (!shouldSelect) {
            groupIds.forEach(id => newSet.delete(id));
        } else {
            groupIds.forEach(id => newSet.add(id));
        }
        setSelectedIds(newSet);
    };

    const handleRandomSelect = () => {
        const count = parseInt(randomCount);
        if (isNaN(count) || count <= 0) return;
        
        // Shuffle current view (libraryFilteredWords)
        const allIds = libraryFilteredWords.map(w => w.id);
        for (let i = allIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
        }
        
        const selected = allIds.slice(0, Math.min(count, allIds.length));
        setSelectedIds(new Set(selected));
    };

    const clearSelection = () => setSelectedIds(new Set());

    // ---- Delete logic ----
    // pendingDeleteIds: null = dialog closed, string[] = ids to confirm
    const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
    const [isWordDeleting, setIsWordDeleting] = useState(false);

    const requestDeleteWords = (e: React.MouseEvent, ids: string[]) => {
        e.stopPropagation();
        if (ids.length === 0) return;
        setPendingDeleteIds(ids);
    };

    const confirmDeleteWords = async () => {
        if (!pendingDeleteIds || pendingDeleteIds.length === 0 || !userId) return;
        setIsWordDeleting(true);
        try {
            await deleteWordsByIds(userId, pendingDeleteIds);
            // Remove from local selected set
            setSelectedIds(prev => {
                const next = new Set(prev);
                pendingDeleteIds.forEach(id => next.delete(id));
                return next;
            });
            setPendingDeleteIds(null);
            onRefresh?.();
        } catch (err) {
            console.error('[LibraryMode] Delete word error:', err);
        } finally {
            setIsWordDeleting(false);
        }
    };

    const handlePreviewAudio = async (e: React.MouseEvent, word: WordEntry) => {
      e.stopPropagation();
      if (playingPreviewWordId) return;

      setPlayingPreviewWordId(word.id);
      try {
        await playWordAudioService(word.text, word.language || 'en');
      } catch (error) {
        console.error('[LibraryMode] Preview audio failed:', error);
      } finally {
        setPlayingPreviewWordId(null);
      }
    };

    const handleGenerateImageClick = async (e: React.MouseEvent, word: WordEntry) => {
      e.stopPropagation();
      if (!onGenerateImageForWord || generatingWordIds.has(word.id)) return;

      const hasExistingImage = cachedImageWordIds.has(word.id) || !!word.image_url || !!word.image_path;
      setGeneratingWordIds(prev => {
        const next = new Set(prev);
        next.add(word.id);
        return next;
      });
      try {
        await onGenerateImageForWord({
          id: word.id,
          text: word.text,
          language: word.language || 'en',
          hasExistingImage,
        });
      } finally {
        setGeneratingWordIds(prev => {
          const next = new Set(prev);
          next.delete(word.id);
          return next;
        });
      }
    };

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 animate-in fade-in slide-in-from-bottom-4 duration-500 min-h-[calc(100vh-100px)] flex flex-col md:flex-row gap-6">
            <ImagePreviewModal
                items={libraryItems}
                currentId={previewId}
                onChangeCurrentId={setPreviewId}
                onClose={() => setPreviewId(null)}
            />
            
            {/* Sidebar Tools */}
            <div className="w-full md:w-80 flex flex-col gap-6 flex-shrink-0">
                <div className="flex items-center gap-4 mb-2">
                     <button onClick={onClose} className="p-3 bg-mid-charcoal hover:bg-text-light hover:text-charcoal rounded-full transition-colors border border-mid-charcoal">
                        <span className="material-symbols-outlined">arrow_back</span>
                     </button>
                     <div>
                        <h2 className="font-headline text-3xl text-white tracking-wide">{tr("LIBRARY", "单词库")}</h2>
                        <p className="font-mono text-[10px] text-text-dark uppercase">{new Set(words.map((w: WordEntry) => w.text)).size} {tr('UNIQUE WORDS', '个不同单词')} ({selectedLibraries.has('All') ? tr('SHOWING ALL', '显示全部') : tr(`FILTERED: ${libraryFilteredWords.length}`, `筛选后：${libraryFilteredWords.length}`)})</p>
                     </div>
                </div>

                <div className="bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg">
                    <h3 className="font-headline text-xl text-electric-blue mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined">casino</span>
                        {tr("RANDOMIZER", "随机选词")}
                    </h3>
                    <div className="flex gap-2">
                        <input 
                            type="number" 
                            value={randomCount}
                            onChange={(e) => setRandomCount(e.target.value)}
                            className="w-20 bg-dark-charcoal border border-mid-charcoal rounded-lg px-3 py-2 text-white font-mono text-center focus:border-electric-blue outline-none"
                            min="1"
                            max={libraryFilteredWords.length}
                        />
                        <button 
                            onClick={handleRandomSelect}
                            className="flex-1 bg-mid-charcoal hover:bg-electric-blue hover:text-charcoal text-white rounded-lg px-4 py-2 font-headline tracking-wider transition-colors"
                        >
                            {tr("PICK RANDOM", "随机选择")}
                        </button>
                    </div>
                </div>

                <LibrarySelector
                    selectedLibraries={selectedLibraries}
                    onChange={setSelectedLibraries}
                    availableLibraries={availableLibraries}
                    userId={userId || ''}
                    onImportComplete={() => {
                        if (onRefresh) onRefresh();
                    }}
                />

                {/* Advanced Filters Panel */}
                {/* 高级过滤面板 */}
                <div className="bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-headline text-xl text-electric-blue flex items-center gap-2">
                            <span className="material-symbols-outlined">filter_list</span>
                            {tr("FILTERS", "筛选")}
                        </h3>
                        <button
                            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                            className="text-text-dark hover:text-electric-blue transition-colors"
                        >
                            <span className="material-symbols-outlined">
                                {showAdvancedFilters ? 'expand_less' : 'expand_more'}
                            </span>
                        </button>
                    </div>

                    {showAdvancedFilters && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                            {/* Real-time Statistics */}
                            {/* 实时统计 */}
                            <div className="bg-dark-charcoal/50 rounded-lg p-3 space-y-2">
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] text-text-dark uppercase">{tr("Mistake Words", "错词数量")}</span>
                                    <span className="font-mono text-sm text-red-400">
                                        {words.filter(w => w.tags?.includes('Mistake')).length}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] text-text-dark uppercase">{tr("High Risk (≥2)", "高风险词（≥2）")}</span>
                                    <span className="font-mono text-sm text-orange-400">
                                        {words.filter(w => w.error_count >= 2).length}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="text-[10px] text-text-dark uppercase">{tr("Visible", "当前可见")}</span>
                                    <span className="font-mono text-sm text-electric-blue">
                                        {sortedWords.filter(w => w.text.toLowerCase().includes(searchTerm.toLowerCase())).length}
                                    </span>
                                </div>
                            </div>

                            {/* Mistake Bank Filter */}
                            {/* 错词库过滤 */}
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className="relative">
                                    <input
                                        type="checkbox"
                                        checked={filterMistakeOnly}
                                        onChange={(e) => setFilterMistakeOnly(e.target.checked)}
                                        className="sr-only"
                                    />
                                    <div className={`w-5 h-5 rounded border-2 transition-all flex items-center justify-center
                                        ${filterMistakeOnly
                                            ? 'bg-red-500 border-red-500'
                                            : 'border-mid-charcoal group-hover:border-red-400'
                                        }`}
                                    >
                                        {filterMistakeOnly && (
                                            <span className="material-symbols-outlined text-charcoal text-sm">check</span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1">
                                    <div className="text-sm text-text-light group-hover:text-white transition-colors">
                                        {tr("Mistake Bank Only", "仅显示错词")}
                                    </div>
                                    <div className="text-[10px] text-text-dark font-mono uppercase">
                                        {tr("Show only words with errors", "只显示有错误记录的单词")}
                                    </div>
                                </div>
                            </label>

                            {/* Minimum Error Count Slider */}
                            {/* 最小错误计数滑块 */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm text-text-light">
                                        {tr("Min Error Count", "最低错误次数")}
                                    </label>
                                    <span className={`font-mono text-sm px-2 py-0.5 rounded ${
                                        filterMinErrorCount
                                            ? 'bg-orange-500/20 text-orange-400'
                                            : 'bg-mid-charcoal text-text-dark'
                                    }`}>
                                        {filterMinErrorCount ? `≥ ${filterMinErrorCount}` : tr('All', '全部')}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="5"
                                    step="0.5"
                                    value={filterMinErrorCount || 0}
                                    onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        setFilterMinErrorCount(val > 0 ? val : null);
                                    }}
                                    className="w-full h-2 bg-dark-charcoal rounded-lg appearance-none cursor-pointer
                                        [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                                        [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-orange-400
                                        [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all
                                        [&::-webkit-slider-thumb]:hover:bg-orange-300"
                                />
                                <div className="flex justify-between text-[10px] text-text-dark font-mono">
                                    <span>0</span>
                                    <span>1</span>
                                    <span>2</span>
                                    <span>3</span>
                                    <span>4</span>
                                    <span>5+</span>
                                </div>
                            </div>

                            {/* Reset Button */}
                            {/* 重置按钮 */}
                            <button
                                onClick={() => {
                                    setFilterMistakeOnly(false);
                                    setFilterMinErrorCount(null);
                                }}
                                className="w-full px-4 py-2 rounded-lg border border-mid-charcoal text-text-dark hover:text-electric-blue hover:border-electric-blue transition-all font-mono text-xs uppercase"
                            >
                                {tr("Reset Filters", "重置筛选")}
                            </button>

                            {/* Status Icons Legend */}
                            {/* 状态图标图例 */}
                            <div className="mt-4 pt-4 border-t border-mid-charcoal space-y-2">
                                <div className="text-[10px] text-text-dark uppercase tracking-wide mb-2">{tr("Status Icons", "状态图标")}</div>

                                <div className="flex items-center gap-2 text-xs">
                                    <span className="material-symbols-outlined text-sm text-red-400">error</span>
                                    <span className="text-text-light">{tr("Error Count", "错误次数")}</span>
                                    <span className="text-text-dark ml-auto text-[10px]">{tr("Higher = more errors", "数值越高，错误越多")}</span>
                                </div>

                                <div className="flex items-center gap-2 text-xs">
                                    <span className="material-symbols-outlined text-sm text-red-500">bookmark</span>
                                    <span className="text-text-light">{tr("In Mistake Bank", "已加入错词库")}</span>
                                    <span className="text-text-dark ml-auto text-[10px]">{tr("Added for review", "已加入复习")}</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg flex-1 flex flex-col">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-headline text-xl text-electric-blue flex items-center gap-2">
                            <span className="material-symbols-outlined">grid_view</span>
                            {tr("A-Z MATRIX", "字母矩阵")}
                        </h3>
                        <span className="text-[10px] text-text-dark uppercase">{tr("Drag to select", "拖动以多选")}</span>
                    </div>
                    
                    <div 
                        className="grid grid-cols-5 gap-2 select-none"
                        onMouseLeave={() => setIsMouseDown(false)}
                    >
                        {alphabet.map(letter => {
                            const hasWords = grouped[letter]?.length > 0;
                            const allSelected = hasWords && grouped[letter].every(w => selectedIds.has(w.id));
                            const partialSelected = !allSelected && hasWords && grouped[letter].some(w => selectedIds.has(w.id));
                            
                            return (
                                <button
                                    key={letter}
                                    onMouseDown={() => {
                                        if (!hasWords) return;
                                        setIsMouseDown(true);
                                        // 不立即选中——等待判定是点击（滚动）还是拖拽（多选）
                                        pressStateRef.current = { letter, moved: false };
                                    }}
                                    onMouseEnter={() => {
                                        if (!isMouseDown || !hasWords) return;
                                        const st = pressStateRef.current;
                                        if (!st) return;
                                        if (!st.moved) {
                                            // 首次进入"另一个字母" → 视为拖拽开始：先把起始字母纳入选中
                                            if (letter !== st.letter) {
                                                toggleLetterGroup(st.letter);
                                                st.moved = true;
                                                toggleLetterGroup(letter);
                                            }
                                            // 仍在起始字母上 → 可能是纯点击，暂不动
                                        } else {
                                            // 拖拽进行中：涂抹选中当前字母
                                            toggleLetterGroup(letter);
                                        }
                                    }}
                                    onMouseUp={() => setIsMouseDown(false)}
                                    onClick={() => {
                                        if (!hasWords) return;
                                        // 仅在"纯点击（未拖拽）"时滚动；跨字母拖拽不会触发按钮 click
                                        const st = pressStateRef.current;
                                        if (!st || !st.moved) scrollToLetter(letter);
                                        pressStateRef.current = null;
                                    }}
                                    disabled={!hasWords}
                                    className={`
                                        aspect-square rounded-lg font-headline text-xl flex items-center justify-center transition-all relative overflow-hidden
                                        ${!hasWords ? 'opacity-20 cursor-default border border-transparent' : 'cursor-pointer border border-mid-charcoal hover:border-electric-blue'}
                                        ${allSelected ? 'bg-electric-green text-charcoal' : partialSelected ? 'bg-electric-blue/20 text-electric-blue' : 'bg-dark-charcoal text-text-dark'}
                                    `}
                                >
                                    {letter}
                                    {partialSelected && <div className="absolute bottom-1 w-1 h-1 bg-electric-blue rounded-full"></div>}
                                </button>
                            );
                        })}
                    </div>
                </div>


            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col h-[calc(100vh-100px)] sticky top-[80px] bg-light-charcoal/50 rounded-2xl border border-mid-charcoal overflow-hidden relative">
                {/* Action Bar */}
                <div className="p-4 border-b border-mid-charcoal bg-light-charcoal flex flex-wrap gap-4 justify-between items-center z-20">
                    <div className="relative group w-full md:w-auto md:min-w-[300px]">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-dark group-focus-within:text-electric-blue transition-colors">search</span>
                        <input 
                            type="text" 
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            placeholder={tr("Search library...", "搜索单词库…")}
                            className="w-full bg-dark-charcoal border border-mid-charcoal rounded-xl py-2 pl-10 pr-4 text-white focus:border-electric-blue outline-none transition-all font-mono text-sm"
                        />
                    </div>
                    
                    <div className="flex gap-2 w-full md:w-auto justify-end">
                         {selectedIds.size > 0 && (
                            <>
                                <button 
                                    onClick={clearSelection}
                                    className="px-4 py-2 rounded-lg text-text-dark hover:text-red-400 font-mono text-xs uppercase hover:bg-mid-charcoal transition-colors"
                                >
                                    {tr("Reset", "清空选择")}
                                </button>
                                <button
                                    onClick={(e) => requestDeleteWords(e, Array.from(selectedIds))}
                                    className="px-4 py-2 bg-red-500/10 border border-red-500/40 text-red-400 font-headline text-sm rounded-xl hover:bg-red-500/20 hover:border-red-400 transition-colors flex items-center gap-1 animate-in zoom-in"
                                >
                                    <span className="material-symbols-outlined text-base">delete</span>
                                    {tr('DELETE', '删除')} ({selectedIds.size})
                                </button>
                                <button 
                                    onClick={() => onTest(Array.from(selectedIds))}
                                    className="px-6 py-2 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors flex items-center gap-2 shadow-[0_0_15px_rgba(0,240,255,0.3)] animate-in zoom-in"
                                >
                                    <span className="material-symbols-outlined">checklist</span>
                                    {tr('TEST', '测验')} ({selectedIds.size})
                                </button>
                            </>
                         )}
                    </div>
                </div>

                {/* Word List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 bg-dark-charcoal/30">
                    {Object.keys(grouped).length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-text-dark opacity-50">
                            <span className="material-symbols-outlined text-6xl mb-4">search_off</span>
                            <p className="font-headline text-xl">{tr("No words found", "未找到单词")}</p>
                        </div>
                    ) : (
                        Object.keys(grouped).sort().map(letter => {
                            if (grouped[letter].length === 0) return null;
                            return (
                                <div
                                    key={letter}
                                    className="mb-8"
                                    ref={node => { letterSectionRefs.current[letter] = node; }}
                                >
                                    <div className="flex items-center gap-4 mb-4 border-b border-mid-charcoal/50 pb-2">
                                        <h3 className="font-headline text-3xl text-electric-blue w-8">{letter}</h3>
                                        <span className="text-[10px] font-mono text-text-dark opacity-50 ml-auto">{grouped[letter].length} {tr('items', '个词')}</span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                        {grouped[letter].map(word => {
                                            const severity = getErrorSeverity(word.error_count);
                                          const hasGeneratedImage = (cachedImageWordIds.has(word.id) || !!word.image_url || !!word.image_path);
                                          const isGenerating = generatingWordIds.has(word.id);
                                            return (
                                                <div
                                                    key={word.id}
                                                    onClick={() => toggleSelection(word.id)}
                                                    className={`px-4 py-4 min-h-[70px] rounded-lg border cursor-pointer transition-all flex flex-col justify-center gap-2 group relative overflow-hidden ${
                                                        selectedIds.has(word.id)
                                                        ? 'bg-electric-blue/10 border-electric-blue shadow-[inset_0_0_10px_rgba(0,240,255,0.1)]'
                                                        : 'bg-light-charcoal border-mid-charcoal hover:border-text-light'
                                                    }`}
                                                >
                                                    <button
                                                      onClick={(e) => {
                                                        if (isGenerating) return;
                                                        if (hasGeneratedImage) {
                                                          e.stopPropagation();
                                                          setPreviewId(word.id);
                                                        } else {
                                                          handleGenerateImageClick(e, word);
                                                        }
                                                      }}
                                                      disabled={isGenerating}
                                                      className={`absolute top-1 right-1 z-10 w-6 h-6 rounded flex items-center justify-center transition-colors ${isGenerating ? 'opacity-70 cursor-wait' : 'hover:bg-dark-charcoal/60'} ${hasGeneratedImage ? 'text-electric-green' : 'text-yellow-400'}`}
                                                      title={isGenerating ? tr('Generating…', '生成中…') : hasGeneratedImage ? tr('View picture', '点击查看大图') : tr('Generate picture', '未生成，点击立即生成')}
                                                      aria-label={isGenerating ? tr(`Generating a picture for ${word.text}`, `正在生成 ${word.text} 的图片`) : hasGeneratedImage ? tr(`View the picture for ${word.text}`, `查看 ${word.text} 的大图`) : tr(`Generate a picture for ${word.text}`, `生成 ${word.text} 的图片`)}
                                                    >
                                                      <span className={`material-symbols-outlined text-sm ${isGenerating ? 'animate-spin' : ''}`}>{isGenerating ? 'sync' : 'image'}</span>
                                                    </button>

                                                    {/* Delete Button - hover visible */}
                                                    <button
                                                        onClick={(e) => requestDeleteWords(e, [word.id])}
                                                        className="absolute top-1 right-8 w-6 h-6 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-text-dark hover:text-red-400 transition-all z-10"
                                                        title={tr(`Delete "${word.text}"`, `删除 "${word.text}"`)}
                                                        aria-label={tr(`Delete ${word.text}`, `删除 ${word.text}`)}
                                                    >
                                                        <span className="material-symbols-outlined text-sm">delete</span>
                                                    </button>

                                                    {/* Main Content: Checkbox + Word */}
                                                    <div className="flex items-start gap-3">
                                                        <div className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors flex-shrink-0 ${selectedIds.has(word.id) ? 'bg-electric-blue border-electric-blue' : 'border-text-dark bg-transparent'}`}>
                                                            {selectedIds.has(word.id) && <span className="material-symbols-outlined text-charcoal text-[10px] font-bold">check</span>}
                                                        </div>
                                                      <div className="min-w-0 flex-1">
                                                        <span className={`block font-mono text-sm truncate ${selectedIds.has(word.id) ? 'text-white' : 'text-text-light'}`}>{word.text}</span>
                                                        <span className={`mt-1 block text-xs leading-relaxed line-clamp-2 ${selectedIds.has(word.id) ? 'text-electric-blue/90' : 'text-text-dark'}`}>
                                                          {wordMeaningForLanguage(word, isZh)}
                                                        </span>
                                                      </div>
                                                    </div>

                                                    {/* Status Indicators */}
                                                    <div className="flex items-center justify-between gap-2 flex-wrap">
                                                      <button
                                                        onClick={(e) => handlePreviewAudio(e, word)}
                                                        className={`w-8 h-8 rounded-full flex items-center justify-center hover:bg-electric-blue hover:text-charcoal transition-colors ${playingPreviewWordId === word.id ? 'text-electric-green animate-pulse' : 'text-text-dark'}`}
                                                        title={tr(`Play pronunciation: ${word.text}`, `播放 ${word.text} 的发音`)}
                                                        aria-label={tr(`Play pronunciation for ${word.text}`, `播放 ${word.text} 的发音`)}
                                                      >
                                                        <span className="material-symbols-outlined text-lg">volume_up</span>
                                                      </button>

                                                      <div className="flex items-center gap-2 flex-wrap ml-auto">
                                                        {/* Error Count Indicator - displays value directly */}
                                                        {word.error_count > 0 && (
                                                          <div className={`flex items-center gap-1 ${severity.color}`}>
                                                            <span className="material-symbols-outlined text-sm">
                                                              {severity.icon}
                                                            </span>
                                                            <span className="text-xs font-mono">{word.error_count.toFixed(1)}</span>
                                                          </div>
                                                        )}

                                                        {/* Mistake Bank Tag - no tooltip */}
                                                        {word.tags?.includes('Mistake') && (
                                                          <span className="material-symbols-outlined text-red-500 text-sm">
                                                            bookmark
                                                          </span>
                                                        )}
                                                      </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* ---- Delete Confirmation Modal ---- */}
            {pendingDeleteIds !== null && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-6 animate-in fade-in duration-200">
                    <div className="bg-light-charcoal border border-red-500/50 rounded-3xl p-8 max-w-sm w-full shadow-[0_0_30px_rgba(239,68,68,0.2)]">
                        <div className="flex items-center gap-3 mb-4 text-red-400">
                            <span className="material-symbols-outlined text-4xl">{isWordDeleting ? 'delete_sweep' : 'warning'}</span>
                            <h3 className="text-2xl font-headline tracking-tight">
                                {isWordDeleting ? tr('Deleting…', '删除中…') : tr('Confirm deletion', '确认删除')}
                            </h3>
                        </div>

                        {isWordDeleting ? (
                            <div className="flex items-center gap-3 py-4">
                                <div className="w-5 h-5 border-2 border-red-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                                <p className="text-text-light font-mono text-sm">{tr("Deleting. Please wait…", "正在删除，请稍候...")}</p>
                            </div>
                        ) : (
                            <>
                                <p className="text-text-light mb-2">
                                    {tr('Delete', '即将删除')}
                                    <span className="text-red-400 font-bold mx-1">{pendingDeleteIds.length}</span>
                                    {tr('word(s)? This cannot be undone.', '个单词，此操作不可撤销。')}
                                </p>
                                <p className="text-text-dark text-xs font-mono mb-6">{tr("Their learning records will also be removed.", "删除后这些单词的学习记录也将一并移除。")}</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setPendingDeleteIds(null)}
                                        className="py-3 rounded-xl bg-mid-charcoal text-text-light hover:bg-text-dark hover:text-charcoal transition-all font-headline tracking-wider"
                                    >
                                        {tr("Cancel", "取消")}
                                    </button>
                                    <button
                                        onClick={confirmDeleteWords}
                                        className="py-3 rounded-xl bg-red-500 text-white hover:bg-red-400 transition-all font-headline tracking-wider flex items-center justify-center gap-2"
                                    >
                                        <span className="material-symbols-outlined text-base">delete_forever</span>
                                        {tr("Confirm deletion", "确认删除")}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// --- Input Mode Component ---
const InputMode: React.FC<{ 
  initialWords?: WordEntry[],
  currentLibrary: string, // The library tag of the session being edited (or 'Custom' for new sessions)
  onComplete: (words: EditableWord[], deletedIds: string[]) => void,
  onCancel: () => void,
  onDeleteWord?: (id: string) => Promise<void>,
  allWords: WordEntry[],
  cachedImageWordIds?: Set<string>,
  cachedImageDataUrls?: Record<string, string>,
  onGenerateImageForWord?: (word: { id: string; text: string; language?: string | null; hasExistingImage?: boolean }) => Promise<boolean>
}> = ({ initialWords = [], currentLibrary, onComplete, onCancel, onDeleteWord, allWords, cachedImageWordIds = new Set(), cachedImageDataUrls = {}, onGenerateImageForWord }) => {
  const { isZh } = useLanguage();
  const tr = (en: string, zh: string) => isZh ? zh : en;
  const [currentWords, setCurrentWords] = useState<EditableWord[]>(
    initialWords.map(w => createEditableWord({
      id: w.id,
      text: w.text,
      hasImage: !!w.image_url || !!w.image_path,
      imageUrl: w.image_url || undefined,
      definition_cn: w.definition_cn || undefined,
      definition_en: w.definition_en || undefined,
      meaning_options: w.meaning_options || undefined,
      selected_meaning_key: w.selected_meaning_key || undefined,
      language: w.language || 'en'
    }))
  );
  // We don't use deletedIds for batch delete anymore based on new requirements, 
  // but keeping it empty for compatibility with onComplete refactoring if needed.
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [validationStage, setValidationStage] = useState<InputValidationStage>('IDLE');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<{ en: string; zh: string } | null>(null);
  const [serviceErrorWord, setServiceErrorWord] = useState<string | null>(null);

  // Phrase validation states
  const [collocationWarning, setCollocationWarning] = useState<{
    phrase: string;
    suggestion?: string;
  } | null>(null);
  const [pendingPhrase, setPendingPhrase] = useState<string | null>(null);
  
  // Feature 1: Drill Logic
  const [targetWord, setTargetWord] = useState<string | null>(null);
  const [targetDefinitionCn, setTargetDefinitionCn] = useState<string | null>(null);
  const [targetDefinitionEn, setTargetDefinitionEn] = useState<string | null>(null);
  const [targetMeaningOptions, setTargetMeaningOptions] = useState<WordMeaningOption[]>([]);
  const [targetSelectedMeaningKey, setTargetSelectedMeaningKey] = useState<string | null>(null);
  const repeatCount = 3;
  const [drillProgress, setDrillProgress] = useState<number>(0);
  const [inputStatus, setInputStatus] = useState<'idle' | 'correct' | 'wrong'>('idle');
  const [pendingMeaningSelection, setPendingMeaningSelection] = useState<{
    text: string;
    partOfSpeech: string;
    meaningZh: string;
    editingTempId?: string;
  } | null>(null);

  // Word-family drill. When the user enters an inflected form (went/shoes/...),
  // `familySuggestion` holds the prompt banner data (user picks one of three).
  // After they choose "add all", `familyQueue` drives the sequential 3× drill
  // across each form. Both null in the normal single-word flow.
  const [familySuggestion, setFamilySuggestion] = useState<{
    inputText: string;
    headword: string;
    forms: string[];
    reason: string;
  } | null>(null);
  const [familyQueue, setFamilyQueue] = useState<{
    headword: string;
    forms: string[];
    index: number;
  } | null>(null);

  // Feature 2: Audio
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);

  // Bug Fix: Delete Confirmation
  const [wordToDelete, setWordToDelete] = useState<{ index: number, item: any } | null>(null);
  
  // Bug Fix: Unsaved Changes Warning
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);
  const [generatingWordTempIds, setGeneratingWordTempIds] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingLockRef = useRef(false);
  const fallbackMeaning = '暂无中文释义';

  // 带图单词列表，用于全屏预览与缩略图导航（草稿图优先，其次持久化 URL，最后缓存）
  const inputItems = useMemo(() => {
    return currentWords
      .map((w) => {
        const src = w.imageBase64 || w.imageUrl || (w.id ? cachedImageDataUrls[w.id] : undefined);
        if (!src) return null;
        return { id: w.id || w.tempId, text: w.text, imageSrc: src };
      })
      .filter(Boolean) as { id: string; text: string; imageSrc: string }[];
  }, [currentWords, cachedImageDataUrls]);

  const validationStageLabel: Record<InputValidationStage, string> = {
    IDLE: tr('VALIDATING…', '正在验证…'),
    VALIDATING_SPELLING: tr('VALIDATING SPELLING…', '正在验证拼写…'),
    VALIDATING_PHRASE: tr('VALIDATING PHRASE STRUCTURE…', '正在验证短语结构…'),
    CHECKING_COLLOCATION: tr('CHECKING PHRASE NATURALNESS…', '正在检查短语搭配…'),
    GENERATING_CHINESE_MEANING: tr('GETTING WORD MEANINGS…', '正在获取单词释义…'),
    GENERATING_PRONUNCIATION: tr('GENERATING PRONUNCIATION…', '正在生成发音…'),
    FINALIZING: tr('FINALIZING WORD…', '正在完成单词准备…'),
  };

  const validationStageStep: Partial<Record<InputValidationStage, number>> = {
    VALIDATING_SPELLING: 1,
    VALIDATING_PHRASE: 1,
    CHECKING_COLLOCATION: 2,
    GENERATING_CHINESE_MEANING: 3,
    GENERATING_PRONUNCIATION: 4,
    FINALIZING: 5,
  };
  const validationTotalSteps = 5;

  const normalizeAcceptedInput = (rawInput: string, suggestion?: string) => {
    const trimmedRaw = rawInput.trim();
    const trimmedSuggestion = suggestion?.trim();
    if (!trimmedSuggestion) return trimmedRaw;
    return trimmedSuggestion.toLowerCase() === trimmedRaw.toLowerCase() ? trimmedSuggestion : trimmedRaw;
  };

  // Collapse runs of internal whitespace into a single space and trim edges.
  // Used for the drill target text and the repeat-input comparison so a
  // multi-word phrase typed with a stray double-space or tab still matches.
  // The UI hides these extra spaces (HTML collapses them in the placeholder
  // and rendered text), so without this the mismatch is invisible and the
  // user sees a baffling "Type X again!" on every repeat.
  const collapseWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim();

  const buildFallbackMeaningOption = (text: string, details?: Partial<ResolvedDictionaryDetails>): WordMeaningOption => {
    const meaningZh = details?.definition_cn?.trim() || fallbackMeaning;
    return {
      key: `na::${meaningZh.trim().toLowerCase()}`,
      meaningZh,
      partOfSpeech: null,
      definitionEn: details?.definition_en?.trim() || text,
      sourceProvider: 'input-fallback',
    };
  };

  const normalizeMeaningOptions = (text: string, details?: Partial<ResolvedDictionaryDetails>): WordMeaningOption[] => {
    const options = (details?.meaning_options || []).filter(option => option?.meaningZh?.trim()).map(option => ({
      ...option,
      key: option.key || `na::${option.meaningZh.trim().toLowerCase()}`,
      meaningZh: option.meaningZh.trim(),
    }));

    if (options.length > 0) {
      return options;
    }

    return [buildFallbackMeaningOption(text, details)];
  };

  const startWordDrill = (text: string, details?: ResolvedDictionaryDetails) => {
    // Normalize internal whitespace before storing/using the drill target.
    // This keeps the saved word text clean AND makes the repeat comparison
    // resilient to accidental double-spaces/tabs in a phrase.
    const drillText = collapseWhitespace(text);
    const normalizedMeaningOptions = normalizeMeaningOptions(drillText, details);
    const selectedMeaningKey = details?.selected_meaning_key && normalizedMeaningOptions.some(option => option.key === details.selected_meaning_key)
      ? details.selected_meaning_key
      : normalizedMeaningOptions[0]?.key || null;

    setTargetWord(drillText);
    setTargetDefinitionCn(details?.definition_cn || normalizedMeaningOptions[0]?.meaningZh || fallbackMeaning);
    setTargetDefinitionEn(details?.definition_en || null);
    setTargetMeaningOptions(normalizedMeaningOptions);
    setTargetSelectedMeaningKey(selectedMeaningKey);
    setDrillProgress(1);
    setInputValue('');
    setInputStatus('correct');
    playDing();
    playWordAudio(drillText);

  };

  // Track if there are unsaved changes
  const hasUnsavedChanges = () => {
    // New words added (comparing length with initial words)
    const newWordsCount = currentWords.filter(w => !w.id).length;
    // Words deleted from initial set (via deletedIds or onDeleteWord immediate sync)
    const deletedCount = initialWords.length - currentWords.filter(w => w.id).length;
    const meaningsChanged = currentWords.some(w => {
      const original = initialWords.find(item => item.id === w.id);
      return original && (w.definition_cn !== (original.definition_cn || undefined)
        || w.selected_meaning_key !== (original.selected_meaning_key || undefined)
        || JSON.stringify(w.meaning_options || []) !== JSON.stringify(original.meaning_options || []));
    });
    return newWordsCount > 0 || deletedCount > 0 || meaningsChanged;
  };

  const confirmMeaningSelection = () => {
    if (!pendingMeaningSelection) return;

    const meaningZh = normalizeChineseMeaning(pendingMeaningSelection.meaningZh);
    const partOfSpeech = pendingMeaningSelection.partOfSpeech;
    if (!partOfSpeech || !meaningZh) return;
    const selectedOption: WordMeaningOption = {
      key: `${partOfSpeech.toLowerCase()}::${meaningZh.toLowerCase()}`,
      meaningZh,
      partOfSpeech,
      sourceProvider: 'user',
    };

    if (pendingMeaningSelection.editingTempId) {
      const tempId = pendingMeaningSelection.editingTempId;
      setCurrentWords(prev => prev.map(word => {
        if (word.tempId !== tempId) return word;
        const existingOption = word.meaning_options?.find(option => option.key === selectedOption.key && option.meaningZh.trim() === meaningZh);
        return {
          ...word,
          definition_cn: meaningZh,
          meaning_options: [...(word.meaning_options || []).filter(option => option.key !== selectedOption.key), { ...existingOption, ...selectedOption }],
          selected_meaning_key: selectedOption.key,
        };
      }));
      setPendingMeaningSelection(null);
      return;
    }

    const newEntry = createEditableWord({
      text: pendingMeaningSelection.text,
      imageBase64: undefined,
      hasImage: false,
      imageGenerating: true,
      definition_cn: meaningZh,
      meaning_options: [selectedOption],
      selected_meaning_key: selectedOption.key,
      language: 'en',
    });

    setCurrentWords(prev => [...prev, newEntry]);
    triggerDraftImageGeneration(newEntry.tempId, pendingMeaningSelection.text, 'en');
    setPendingMeaningSelection(null);
    setTargetWord(null);
    setTargetDefinitionCn(null);
    setTargetDefinitionEn(null);
    setTargetMeaningOptions([]);
    setTargetSelectedMeaningKey(null);
    setDrillProgress(0);
    setInputValue('');
    setTimeout(() => setInputStatus('idle'), 1000);
    playDing();
    if (familyQueue) {
      const nextIndex = familyQueue.index + 1;
      if (nextIndex < familyQueue.forms.length) {
        setFamilyQueue({ ...familyQueue, index: nextIndex });
        startWordDrill(familyQueue.forms[nextIndex]);
      } else {
        setFamilyQueue(null);
      }
    }
  };

  const handleCancelClick = () => {
    if (hasUnsavedChanges()) {
      setShowUnsavedWarning(true);
    } else {
      onCancel();
    }
  };

  const playWordAudio = async (text: string) => {
      if (playingAudio) return;
      setPlayingAudio(text);

      try {
        // 直接使用本地 Web Speech API
        await playWordAudioService(text, 'en');
      } catch (e) {
        console.error("Audio playback error:", e);
      }
      
      setPlayingAudio(null);
  };

  const handleInputEnter = async () => {
    if (processingLockRef.current || isProcessing) {
      return;
    }

    setErrorMsg(null);
    setServiceErrorWord(null);
    setInputStatus('idle');
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // --- PHASE 1: New Word Validation ---
    if (!targetWord) {
      // Local Check: Check within current session's word list
      if (currentWords.some(w => w.text.toLowerCase() === trimmed.toLowerCase())) {
          setErrorMsg({ en: `"${trimmed}" is already in this session.`, zh: `“${trimmed}”已在当前学习批次中。` });
          playBuzzer();
          return;
      }
      
      // Global Check: Check if word exists anywhere in the user's collection
      const existingWord = allWords.find(w => w.text.toLowerCase() === trimmed.toLowerCase());
      if (existingWord) {
          setErrorMsg({ en: `"${trimmed}" already exists in your collection.`, zh: `“${trimmed}”已在你的单词库中。` });
          playBuzzer();
          return;
      }

      setIsProcessing(true);
      processingLockRef.current = true;

      try {
        // Check if input is a phrase (contains spaces)
        const isPhrase = trimmed.includes(' ');
        setValidationStage(isPhrase ? 'VALIDATING_PHRASE' : 'VALIDATING_SPELLING');

        let validation;
        if (isPhrase) {
          // Use phrase validation for multi-word inputs
          validation = await aiService.validatePhrase(trimmed);
        } else {
          // Use single word validation
          validation = await aiService.validateSpelling(trimmed);
        }

        if (validation.serviceError) {
          setServiceErrorWord(trimmed);
          playBuzzer();
          return;
        }

        // Handle phrase length errors
        if (validation.error === 'TOO_MANY_WORDS' || validation.error === 'TOO_FEW_WORDS') {
          playBuzzer();
          setErrorMsg({ en: 'Please enter a phrase with 2–3 words.', zh: '请输入由 2–3 个单词组成的短语。' });
          return;
        }

        if (!validation.isValid) {
          playBuzzer();
          // Show highlighted phrase if available
          const displayText = validation.highlightedPhrase || validation.suggestion || 'something else';
          setErrorMsg({ en: `Did you mean "${displayText}"?`, zh: `你想输入的是“${displayText}”吗？` });
          return;
        }

        const normalizedInput = normalizeAcceptedInput(trimmed, validation.suggestion);

        // Word-family detection (single words only — mutually exclusive with the
        // 2-word collocation check below). If the input is an inflected form, we
        // surface its family (go/went/gone) so the user can choose to practise
        // and store all forms. Load its lemma tables only after a valid token;
        // an unavailable optional detector must not block the single-word flow.
        if (!isPhrase) {
          const family = await import('./services/wordFamilyService')
            .then(({ detectWordFamily }) => detectWordFamily(normalizedInput))
            .catch(error => {
              console.warn('[wordFamilyService] Optional detector unavailable:', error);
              return null;
            });
          if (family?.isFamilyMember && family.forms && family.forms.length > 1) {
            const existingLower = new Set<string>([
              ...currentWords.map(w => w.text.toLowerCase()),
              ...allWords.map(w => w.text.toLowerCase()),
            ]);
            const freshForms = family.forms.filter(f => !existingLower.has(f.toLowerCase()));
            // Only prompt if ≥2 forms are new — otherwise the family is already
            // covered and a normal single-word add reads better.
            if (freshForms.length >= 2) {
              setFamilySuggestion({
                inputText: normalizedInput,
                headword: family.headword!,
                forms: freshForms,
                reason: family.reason!,
              });
              playBuzzer();
              return;
            }
          }
        }

        // Handle 2-word phrase collocation check
        if (validation.needsCollocationCheck) {
          try {
            setValidationStage('CHECKING_COLLOCATION');
            const collocationResult = await aiService.validateCollocation(trimmed);

            if (!collocationResult.isCommon) {
              // Show collocation warning
              setCollocationWarning({
                phrase: trimmed,
                suggestion: validation.suggestion
              });
              setPendingPhrase(trimmed);
              playBuzzer();
              return;
            }
          } catch (error) {
            console.error('Collocation check error:', error);
            // On error, continue with the phrase
          }
        }

        setValidationStage('GENERATING_PRONUNCIATION');
        try {
          const { preloadAudio } = await import('./services/pronunciationService');
          await preloadAudio(normalizedInput, 'en');
        } catch (error) {
          console.warn('Pronunciation preload failed:', error);
        }
        setValidationStage('FINALIZING');
        startWordDrill(normalizedInput);
      } finally {
        setIsProcessing(false);
        setValidationStage('IDLE');
        processingLockRef.current = false;
      }
      return;
    }

    // --- PHASE 2: Drill Repetition ---
    if (targetWord) {
        if (collapseWhitespace(trimmed).toLowerCase() === collapseWhitespace(targetWord).toLowerCase()) {
            // Correct
            const newProgress = drillProgress + 1;
            setDrillProgress(newProgress);
            setInputValue('');
            setInputStatus('correct');
            playDing();
            
            if (newProgress >= repeatCount) {
              finishAddingWord(targetWord);
            }
        } else {
            // Wrong
            setInputStatus('wrong');
            playBuzzer();
            setInputValue(''); // Clear to force retype
            setErrorMsg({ en: `Type "${targetWord}" again!`, zh: `请再次输入“${targetWord}”！` });
        }
    }
  };

  const finishAddingWord = (text: string) => {
    setPendingMeaningSelection({ text, partOfSpeech: '', meaningZh: '' });
    setTargetWord(null);
    setTargetDefinitionCn(null);
    setTargetDefinitionEn(null);
    setTargetMeaningOptions([]);
    setTargetSelectedMeaningKey(null);
    setDrillProgress(0);
    setInputValue('');
    setTimeout(() => setInputStatus('idle'), 1000);
  };

  const handleManualAdd = () => {
    if (serviceErrorWord) {
      const text = serviceErrorWord;
      setServiceErrorWord(null);
      startWordDrill(text);
    } else if (collocationWarning && pendingPhrase) {
      const text = pendingPhrase;
      setCollocationWarning(null);
      setPendingPhrase(null);
      startWordDrill(text);
    }
  };

  // Each family member receives its own meaning after its repetitions.
  const startFamilyDrill = () => {
    if (!familySuggestion) return;
    const { forms, headword } = familySuggestion;
    setFamilySuggestion(null);
    setFamilyQueue({ headword, forms, index: 0 });
    startWordDrill(forms[0]);
  };

  const addCurrentOnlyFromFamily = () => {
    if (!familySuggestion) return;
    const text = familySuggestion.inputText;
    setFamilySuggestion(null);
    startWordDrill(text);
  };

  const cancelFamilySuggestion = () => {
    setFamilySuggestion(null);
    setInputValue('');
  };

  const initiateDelete = (index: number) => {
      setWordToDelete({ index, item: currentWords[index] });
  };

  const confirmDelete = async () => {
      if (!wordToDelete) return;

      console.log("🗑️ confirmDelete called for:", wordToDelete);

      try {
          // New word (not saved yet)
          if (!wordToDelete.item.id) {
              console.log("✅ Deleting new unsaved word");
              const newWords = [...currentWords];
              newWords.splice(wordToDelete.index, 1);
              setCurrentWords(newWords);
          } else {
              // Existing word - Immediate server sync requested
              if (onDeleteWord) {
                  console.log("🔄 Calling onDeleteWord for ID:", wordToDelete.item.id);
                  await onDeleteWord(wordToDelete.item.id);
                  console.log("✅ onDeleteWord completed successfully");
                  // Local update happens via prop update or manual splice if parent doesn't auto-refresh input list
                  // Since we passed `initialWords`, `currentWords` is separate state. We must update it.
                  const newWords = [...currentWords];
                  newWords.splice(wordToDelete.index, 1);
                  setCurrentWords(newWords);
              } else {
                  console.log("⚠️ No onDeleteWord handler, using fallback");
                  // Fallback to old behavior if prop missing
                  setDeletedIds(prev => [...prev, wordToDelete.item.id!]);
                  const newWords = [...currentWords];
                  newWords.splice(wordToDelete.index, 1);
                  setCurrentWords(newWords);
              }
          }
          setWordToDelete(null);
      } catch (error) {
          console.error("❌ confirmDelete failed:", error);
          alert(tr('Could not delete this word. Please try again.', '删除单词失败，请重试。'));
          // 即使失败也关闭模态框，让用户可以重试
          setWordToDelete(null);
      }
  };

  const handleSubmitSession = async () => {
    setIsSaving(true);
    // deletedIds should be empty if we exclusively use immediate delete, but passing it just in case
    await onComplete(currentWords, deletedIds);
  };

  const triggerDraftImageGeneration = useCallback((tempId: string, text: string, language: string = 'en') => {
    setCurrentWords(prev => prev.map(item => item.tempId === tempId ? { ...item, imageGenerating: true } : item));

    void requestQueuedWordImage(text, { language })
      .then(({ dataUrl }) => {
        setCurrentWords(prev => prev.map(item =>
          item.tempId === tempId
            ? { ...item, imageBase64: dataUrl, hasImage: true, imageGenerating: false }
            : item
        ));
      })
      .catch((error) => {
        console.warn('[InputMode] draft image generation failed:', error);
        setCurrentWords(prev => prev.map(item =>
          item.tempId === tempId
            ? { ...item, imageGenerating: false }
            : item
        ));
      });
  }, []);

  const handleGenerateWordImageClick = async (event: React.MouseEvent, word: EditableWord) => {
    event.stopPropagation();
    if (generatingWordTempIds.has(word.tempId)) return;

    const hasGeneratedImage = !!word.imageBase64 || !!word.hasImage || (!!word.id && cachedImageWordIds.has(word.id));
    if (hasGeneratedImage) {
      const confirmed = window.confirm(tr(`"${word.text}" already has a picture. Generate a replacement?`, `"${word.text}" 已有图片，是否重新生成并替换当前图片？`));
      if (!confirmed) return;
    }

    setGeneratingWordTempIds(prev => {
      const next = new Set(prev);
      next.add(word.tempId);
      return next;
    });
    try {
      if (word.id && onGenerateImageForWord) {
        const success = await onGenerateImageForWord({
          id: word.id,
          text: word.text,
          language: word.language || 'en',
          hasExistingImage: hasGeneratedImage,
        });
        if (success) {
          setCurrentWords(prev => prev.map(item =>
            item.tempId === word.tempId
              ? { ...item, hasImage: true, imageBase64: undefined }
              : item
          ));
        }
      } else {
        const generated = await requestQueuedWordImage(word.text, { language: word.language || 'en' });
        const base64 = generated.dataUrl;
        if (base64) {
          setCurrentWords(prev => prev.map(item =>
            item.tempId === word.tempId
              ? { ...item, imageBase64: base64, hasImage: true }
              : item
          ));
          alert(tr(`Picture generated for ${word.text}. Save the session to keep it.`, `已为 ${word.text} 生成图片（本地待保存）`));
        } else {
          alert(tr(`Could not generate a picture for ${word.text}.`, `图片生成失败：${word.text}`));
        }
      }
    } catch (error: any) {
      console.warn('[InputMode] generate image failed:', error);
      alert(tr(`Picture generation failed for ${word.text}.`, `图片生成异常：${word.text}`));
    } finally {
      setGeneratingWordTempIds(prev => {
        const next = new Set(prev);
        next.delete(word.tempId);
        return next;
      });
    }
  };

  const handleVoiceInput = () => {
    setErrorMsg(null);
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert(tr('Speech recognition is not supported in this browser.', '此浏览器不支持语音识别。'));
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.onstart = () => {
      setValidationStage('VALIDATING_SPELLING');
      setIsProcessing(true);
    };
    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      setInputValue(text);
      setIsProcessing(false);
      setValidationStage('IDLE');
      // Auto-submit if needed? No, let user confirm.
    };
    recognition.onerror = () => {
      setIsProcessing(false);
      setValidationStage('IDLE');
    };
    recognition.start();
  };

  const handlePhotoInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      const extracted = await aiService.extractWordFromImage(base64);
      if (extracted) {
        setInputValue(extracted);
      } else {
        alert(tr('Could not extract a word from the picture.', '未能从图片中识别出单词。'));
      }handleCancelClick
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  if (isSaving) {
    return (
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
            <span className="material-symbols-outlined text-6xl text-electric-green animate-pulse">cloud_upload</span>
            <h2 className="font-headline text-2xl text-white"><HoverTranslationText text="Saving Neural Link..." translation="正在保存神经连接数据..." /></h2>
        </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 py-6 animate-in fade-in duration-500 relative">
      <ImagePreviewModal
        items={inputItems}
        currentId={previewId}
        onChangeCurrentId={setPreviewId}
        onClose={() => setPreviewId(null)}
      />
      <div className="w-full flex flex-col items-center gap-3 px-2">
        <div className="w-full grid grid-cols-3 items-center gap-3">
          <div className="flex justify-start">
            <button 
              onClick={handleCancelClick} 
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-light-charcoal border border-mid-charcoal text-text-light hover:text-white hover:border-electric-blue transition-all group"
            >
              <span className="material-symbols-outlined group-hover:-translate-x-1 transition-transform">arrow_back</span>
              <span className="font-mono text-xs uppercase tracking-wider"><HoverTranslationText text="Dashboard" translation="仪表盘" /></span>
            </button>
          </div>

          <div className="flex justify-center">
            <div className="flex items-center gap-3 bg-light-charcoal px-4 py-2 rounded-xl border border-mid-charcoal shadow-lg">
              <span className="material-symbols-outlined text-electric-blue">checklist</span>
              <label className="text-xs font-headline text-text-dark tracking-widest uppercase"><HoverTranslationText text="Session Words:" translation="本批次单词：" /></label>
              <span className="font-mono font-bold text-xl text-electric-green leading-none">{currentWords.length}</span>
            </div>
          </div>

          <div className="flex justify-end">
            <div className="flex items-center gap-3 bg-light-charcoal border border-mid-charcoal px-4 py-2 rounded-full">
              <span className="text-[10px] font-mono uppercase text-text-dark"><HoverTranslationText text="Repetitions" translation="添加单词时，要重复输入的次数" /></span>
              <span className="font-mono text-electric-blue font-bold w-4 text-center">{repeatCount}</span>
            </div>
          </div>
        </div>

        <div className="h-6 flex items-center justify-center">
          {initialWords.length > 0 && (
            <span className="font-mono text-xs text-electric-blue border border-electric-blue/30 px-3 py-1 rounded-full uppercase tracking-wider"><HoverTranslationText text="Editing Mode" translation="编辑模式" /></span>
          )}
        </div>
      </div>

      <div className="relative flex flex-col items-center">
        {/* Drill Indicators */}
        <div className="flex gap-3 mb-3 h-7 items-end">
            {familyQueue && (
              <div className="self-center flex items-center gap-2 mr-2 px-3 py-1 rounded-full bg-electric-blue/10 border border-electric-blue/30">
                <span className="font-mono text-[10px] uppercase tracking-wider text-electric-blue">{tr('Family', '词族')} · {familyQueue.headword}</span>
                <span className="font-mono text-xs text-white">{familyQueue.index + 1}/{familyQueue.forms.length}</span>
                <div className="flex gap-1 ml-1">
                  {familyQueue.forms.map((f, i) => (
                    <span key={f} className={`w-1.5 h-1.5 rounded-full transition-all ${i < familyQueue.index ? 'bg-electric-green' : i === familyQueue.index ? 'bg-electric-blue animate-pulse' : 'bg-mid-charcoal'}`} />
                  ))}
                </div>
              </div>
            )}
            {targetWord && Array.from({ length: repeatCount }).map((_, i) => (
                <div 
                    key={i} 
                    className={`
                        w-4 h-4 rounded-full border-2 transition-all duration-300
                        ${i < drillProgress 
                            ? 'bg-electric-green border-electric-green shadow-[0_0_10px_rgba(46,230,124,0.5)] transform scale-125' 
                            : 'bg-transparent border-mid-charcoal'
                        }
                    `}
                />
            ))}
        </div>

        <LargeWordInput 
          value={inputValue} 
          onChange={(v) => {
            setInputValue(v);
            if (errorMsg) setErrorMsg(null);
            if (inputStatus !== 'idle') setInputStatus('idle');
          }} 
          onEnter={handleInputEnter}
          placeholder={targetWord ? tr(`TYPE "${targetWord}"`, `输入“${targetWord}”`) : tr('TYPE WORD…', '输入单词…')}
          maxWidth="100%"
          disabled={isProcessing || !!pendingMeaningSelection}
          status={inputStatus}
          hintOverlay={targetWord ? undefined : undefined} 
          showProcessingOverlay={isProcessing}
          processingLabel={validationStageLabel[validationStage]}
          processingStep={validationStageStep[validationStage]}
          processingTotalSteps={validationTotalSteps}
        />
        
        {/* Drill Info Text */}
        {targetWord && (
            <div className="absolute top-0 right-0 transform translate-x-full pl-4 hidden md:block w-48">
                 <div className="bg-light-charcoal/50 border border-electric-blue/30 p-4 rounded-2xl backdrop-blur-md">
                     <p className="font-mono text-[10px] uppercase text-text-dark mb-1"><HoverTranslationText text="Target" translation="目标单词" /></p>
                     <p className="font-serif text-xl text-white truncate">{targetWord}</p>
                     <div className="mt-3 border-t border-electric-blue/10 pt-3">
                       <p className="text-sm text-white leading-relaxed break-words">{tr('Add a Chinese meaning after the repetitions.', '完成重复输入后填写中文释义。')}</p>
                     </div>
                       <p className="text-[10px] text-electric-blue mt-2"><HoverTranslationText text={`Type correctly ${repeatCount} times to add.`} translation={`连续正确输入 ${repeatCount} 次后即可添加。`} /></p>
                 </div>
            </div>
        )}

        {errorMsg && (
          <div className="absolute top-full text-center mt-4 flex justify-center animate-in slide-in-from-top-2 z-50">
            <div className="bg-red-600 border border-red-400 text-white px-6 py-3 rounded-xl flex items-center gap-3 shadow-[0_0_25px_rgba(220,38,38,0.4)]">
               <span className="material-symbols-outlined">report</span>
               <span className="font-mono font-bold tracking-tight">{isZh ? errorMsg.zh : errorMsg.en}</span>
            </div>
          </div>
        )}

        {serviceErrorWord && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 flex justify-center animate-in slide-in-from-top-2 z-50 w-full max-w-md">
            <div className="bg-light-charcoal border-2 border-electric-purple text-white px-8 py-6 rounded-2xl flex flex-col items-center gap-4 shadow-[0_0_40px_rgba(147,51,234,0.3)] w-full text-center">
               <div className="flex items-center gap-3 text-electric-purple mb-1">
                  <span className="material-symbols-outlined text-3xl">cloud_off</span>
                  <span className="font-headline text-xl uppercase tracking-widest"><HoverTranslationText text="Neural Link Offline" translation="神经连接离线" /></span>
               </div>
               <p className="font-mono text-sm text-text-light leading-relaxed">
                  {tr('The validation service is unavailable. We could not check', '验证服务暂时不可用，无法确认')} <span className="text-electric-blue">"{serviceErrorWord}"</span>{tr('.', ' 是否正确。')}
               </p>
               <div className="flex gap-4 w-full">
                  <button 
                    onClick={() => setServiceErrorWord(null)}
                    className="flex-1 py-3 px-4 rounded-xl border border-mid-charcoal hover:bg-mid-charcoal transition-all font-mono text-xs uppercase tracking-widest"
                  >
                    <HoverTranslationText text="Cancel" translation="取消" />
                  </button>
                  <button 
                    onClick={handleManualAdd}
                    className="flex-1 py-3 px-4 rounded-xl bg-electric-purple text-white hover:bg-purple-500 transition-all font-sans font-bold text-sm shadow-lg shadow-purple-900/20"
                  >
                    <HoverTranslationText text="Add Anyway" translation="仍然添加" />
                  </button>
               </div>
            </div>
          </div>
        )}

        {collocationWarning && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 flex justify-center animate-in slide-in-from-top-2 z-50 w-full max-w-md">
            <div className="bg-amber-900/90 border-2 border-amber-500 text-white px-8 py-6 rounded-2xl flex flex-col items-center gap-4 shadow-[0_0_40px_rgba(245,158,11,0.3)] w-full text-center backdrop-blur-sm">
               <div className="flex items-center gap-3 text-amber-400 mb-1">
                  <span className="material-symbols-outlined text-3xl">warning</span>
                  <span className="font-headline text-xl uppercase tracking-widest"><HoverTranslationText text="Uncommon Phrase" translation="非常见短语" /></span>
               </div>
               <p className="font-mono text-sm text-text-light leading-relaxed">
                  <span className="text-electric-blue">"{collocationWarning.phrase}"</span> {tr('may not be a common English phrase.', '可能不是常见的英文短语。')}
               </p>
               {collocationWarning.suggestion && (
                 <p className="font-mono text-xs text-text-dark">
                    {tr('Did you mean:', '你想输入的是：')} <span className="text-electric-blue">{collocationWarning.suggestion}</span>{tr('?', '？')}
                 </p>
               )}
               <div className="flex gap-4 w-full">
                  <button
                    onClick={() => {
                      setCollocationWarning(null);
                      setPendingPhrase(null);
                    }}
                    className="flex-1 py-3 px-4 rounded-xl border border-mid-charcoal hover:bg-mid-charcoal transition-all font-mono text-xs uppercase tracking-widest"
                  >
                    <HoverTranslationText text="Cancel" translation="取消" />
                  </button>
                  <button
                    onClick={handleManualAdd}
                    className="flex-1 py-3 px-4 rounded-xl bg-amber-500 text-white hover:bg-amber-600 transition-all font-sans font-bold text-sm shadow-lg shadow-amber-900/20"
                  >
                    <HoverTranslationText text="Force Add" translation="强制添加" />
                  </button>
               </div>
            </div>
          </div>
        )}

        {familySuggestion && !collocationWarning && !serviceErrorWord && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 flex justify-center animate-in slide-in-from-top-2 z-50 w-full max-w-md">
            <div className="bg-amber-900/90 border-2 border-amber-500 text-white px-8 py-6 rounded-2xl flex flex-col items-center gap-4 shadow-[0_0_40px_rgba(245,158,11,0.3)] w-full text-center backdrop-blur-sm">
               <div className="flex items-center gap-3 text-amber-400 mb-1">
                  <span className="material-symbols-outlined text-3xl">hub</span>
                  <span className="font-headline text-xl uppercase tracking-widest"><HoverTranslationText text="Word Family" translation="词族检测" /></span>
               </div>
               <p className="font-mono text-sm text-text-light leading-relaxed">
                  <span className="text-electric-blue">"{familySuggestion.inputText}"</span> <HoverTranslationText text="belongs to the word family" translation="属于词族" /> <span className="text-electric-blue">{familySuggestion.headword}</span>
               </p>
               <p className="font-serif text-lg text-white tracking-wide">
                  {familySuggestion.forms.join('  ·  ')}
               </p>
               <p className="text-xs text-text-dark"><HoverTranslationText text="Practise every form to master the family?" translation="把每个形式都加入练习吗？" /></p>
               <div className="flex gap-3 w-full">
                  <button
                    onClick={cancelFamilySuggestion}
                    className="flex-1 py-3 px-2 rounded-xl border border-mid-charcoal hover:bg-mid-charcoal transition-all font-mono text-xs uppercase tracking-widest"
                  >
                    <HoverTranslationText text="Cancel" translation="取消" />
                  </button>
                  <button
                    onClick={addCurrentOnlyFromFamily}
                    className="flex-1 py-3 px-2 rounded-xl border border-amber-500/50 text-amber-300 hover:bg-amber-500/10 transition-all font-mono text-xs uppercase tracking-widest"
                  >
                    <HoverTranslationText text="Just This" translation="只加当前" />
                  </button>
                  <button
                    onClick={startFamilyDrill}
                    className="flex-[1.4] py-3 px-2 rounded-xl bg-amber-500 text-white hover:bg-amber-600 transition-all font-sans font-bold text-sm shadow-lg shadow-amber-900/20"
                  >
                    <HoverTranslationText text={`Add All (${familySuggestion.forms.length})`} translation={`一起加入 (${familySuggestion.forms.length})`} />
                  </button>
               </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-6 mt-8">
        <button 
          onClick={handleVoiceInput}
          title={tr("Voice input", "语音输入")}
          className="flex h-24 w-24 items-center justify-center bg-mid-charcoal rounded-full text-white hover:text-electric-blue border-2 border-transparent hover:border-electric-blue transition-all group"
        >
          <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">mic</span>
        </button>
        <button 
          onClick={() => fileInputRef.current?.click()}
          title={tr("Recognize words in a picture", "图片识别")}
          className="flex h-24 w-24 items-center justify-center bg-mid-charcoal rounded-full text-white hover:text-electric-purple border-2 border-transparent hover:border-electric-purple transition-all group"
        >
          <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">photo_camera</span>
          <input type="file" ref={fileInputRef} onChange={handlePhotoInput} className="hidden" accept="image/*" />
        </button>
        <button 
          onClick={handleInputEnter}
          disabled={!inputValue.trim() || isProcessing}
          className="flex h-24 items-center justify-center px-10 bg-mid-charcoal text-white font-headline text-3xl rounded-full hover:bg-electric-blue hover:text-charcoal transition-all disabled:opacity-50 disabled:hover:bg-mid-charcoal disabled:hover:text-white border-2 border-electric-blue"
        >
          <HoverTranslationText text="ENTER" translation="确认输入" />
        </button>
      </div>

      <div className="min-h-[100px]">
        {currentWords.length === 0 ? (
          <div className="text-center text-text-dark opacity-50 font-mono text-sm py-8 border-2 border-dashed border-mid-charcoal rounded-xl">
             <HoverTranslationText text="Words will appear here..." translation="单词会显示在这里..." />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {currentWords.map((w, i) => (
              <MeaningFlipCard
                key={w.tempId}
                wordText={w.text}
                meaning={w.definition_cn}
                definitionEn={w.definition_en}
                meaningOptions={w.meaning_options}
                selectedMeaningKey={w.selected_meaning_key}
                className="h-24"
                frontClassName="rounded-xl"
                backClassName="rounded-xl border border-electric-blue/30 bg-light-charcoal p-3"
                front={
                  <div className="group relative flex h-full items-center justify-between rounded-xl border border-mid-charcoal bg-light-charcoal p-3 text-center transition-all hover:border-text-light">
                    {(() => {
                      const hasGeneratedImage = !!w.imageBase64 || !!w.hasImage || (!!w.id && cachedImageWordIds.has(w.id));
                      const isGenerating = generatingWordTempIds.has(w.tempId) || !!w.imageGenerating;
                      return (
                      <button
                        onClick={(event) => {
                          if (isGenerating) return;
                          if (hasGeneratedImage) {
                            event.stopPropagation();
                            setPreviewId(w.id || w.tempId);
                          } else {
                            handleGenerateWordImageClick(event, w);
                          }
                        }}
                        disabled={isGenerating}
                        className={`absolute top-1 right-1 w-6 h-6 rounded flex items-center justify-center transition-colors ${isGenerating ? 'opacity-70 cursor-wait' : 'hover:bg-dark-charcoal/60'} ${hasGeneratedImage ? 'text-electric-green' : 'text-yellow-400'}`}
                        title={isGenerating ? tr('Generating…', '生成中…') : hasGeneratedImage ? tr('View picture', '点击查看大图') : tr('Generate picture', '未生成，点击立即生成')}
                      >
                        <span className={`material-symbols-outlined text-sm ${isGenerating ? 'animate-spin' : ''}`}>{isGenerating ? 'sync' : 'image'}</span>
                      </button>
                      );
                    })()}
                    <div className="flex items-center gap-2 overflow-hidden flex-1">
                        <button 
                            onClick={(event) => {
                              event.stopPropagation();
                              playWordAudio(w.text);
                            }}
                            className={`w-8 h-8 rounded-full flex items-center justify-center hover:bg-electric-blue hover:text-charcoal transition-colors ${playingAudio === w.text ? 'text-electric-green animate-pulse' : 'text-text-dark'}`}
                        >
                            <span className="material-symbols-outlined text-lg">volume_up</span>
                        </button>
                        <div className="min-w-0 flex-1 text-left">
                          <span className="block truncate font-mono text-electric-blue">{w.text}</span>
                          <span className={`mt-1 block text-[10px] font-mono uppercase tracking-[0.1em] ${normalizeChineseMeaning(w.meaning_options?.find(option => option.key === w.selected_meaning_key)?.meaningZh) || normalizeChineseMeaning(w.definition_cn) ? 'text-text-dark' : 'text-amber-300'}`}>
                            {normalizeChineseMeaning(w.meaning_options?.find(option => option.key === w.selected_meaning_key)?.meaningZh) || normalizeChineseMeaning(w.definition_cn)
                              ? tr('Flip to see the meaning', '点击翻面看中文')
                              : tr('Use pencil to add meaning', '点铅笔填写中文释义')}
                          </span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          const selected = w.meaning_options?.find(option => option.key === w.selected_meaning_key);
                          const rawPart = selected?.partOfSpeech || '';
                          const partMap: Record<string, string> = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', pronoun: 'pron.', preposition: 'prep.', conjunction: 'conj.', interjection: 'int.', article: 'art.', determiner: 'det.', auxiliary: 'aux.', phrase: 'phr.' };
                          const part = partMap[rawPart.toLowerCase()] || rawPart;
                          const savedMeaning = normalizeChineseMeaning(selected?.meaningZh) || normalizeChineseMeaning(w.definition_cn) || '';
                          setPendingMeaningSelection({ text: w.text, editingTempId: w.tempId, partOfSpeech: part, meaningZh: savedMeaning });
                        }}
                        onKeyDown={event => event.stopPropagation()}
                        className="ml-1 w-8 h-8 rounded-lg flex items-center justify-center text-text-dark hover:bg-electric-blue hover:text-charcoal transition-colors"
                        title={tr('Edit Chinese meaning', '编辑中文释义')}
                        aria-label={tr(`Edit Chinese meaning for ${w.text}`, `编辑 ${w.text} 的中文释义`)}
                    >
                        <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button 
                        onClick={(event) => {
                          event.stopPropagation();
                          initiateDelete(i);
                        }}
                        className="ml-2 w-8 h-8 rounded-lg flex items-center justify-center text-text-dark hover:bg-red-500 hover:text-white transition-colors"
                        title={tr("Remove word", "移除单词")}
                    >
                        <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </div>
      
      <div className="flex flex-col items-center gap-4 pt-4 pb-8">
        <button 
            onClick={handleSubmitSession}
            disabled={currentWords.length === 0 || !!targetWord || !!pendingMeaningSelection || !!familyQueue}
            className={`w-full max-w-md py-6 rounded-2xl font-headline text-3xl transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-3 disabled:opacity-50 disabled:transform-none bg-mid-charcoal text-text-light hover:bg-electric-green hover:text-charcoal border-2 border-transparent hover:border-white`}
        >
            <span className="material-symbols-outlined text-4xl">check_circle</span>
            {targetWord || familyQueue ? <HoverTranslationText text="FINISH WORD FIRST" translation="请先完成当前单词" /> : pendingMeaningSelection ? <HoverTranslationText text="SELECT MEANING FIRST" translation="请先选择释义" /> : (initialWords.length > 0 ? <HoverTranslationText text="UPDATE SESSION" translation="更新本次批次" /> : <HoverTranslationText text="FINISH & SAVE" translation="完成并保存" />)}
        </button>
      </div>

      {pendingMeaningSelection && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/80 px-6 backdrop-blur-sm animate-in fade-in duration-300">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-meaning-title"
            onSubmit={(event) => { event.preventDefault(); confirmMeaningSelection(); }}
            className="w-full max-w-2xl rounded-[28px] border border-amber-300/25 bg-[#121419]/95 p-6 shadow-[0_0_50px_rgba(251,191,36,0.12)]"
          >
            <div className="border-b border-white/10 pb-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-amber-300/80">{tr('Add a meaning', '填写释义')}</p>
              <h3 id="manual-meaning-title" className="mt-2 font-headline text-2xl text-white">{tr(`Add a Chinese meaning for ${pendingMeaningSelection.text}`, `为 ${pendingMeaningSelection.text} 填写中文释义`)}</h3>
              <p className="mt-2 text-sm text-text-light">{tr('Choose the part of speech and enter the Chinese meaning to show on the card.', '选择词性并输入中文释义，保存后会显示在单词卡片上。')}</p>
            </div>
            <div className="mt-5 space-y-5">
              <label className="block text-sm font-semibold text-text-light">
                {tr('Part of speech', '词性')}
                <select
                  required
                  autoFocus
                  value={pendingMeaningSelection.partOfSpeech}
                  onChange={event => setPendingMeaningSelection(prev => prev ? { ...prev, partOfSpeech: event.target.value } : prev)}
                  className="mt-2 block w-full rounded-xl border border-white/20 bg-[#1c2028] px-4 py-3 text-white focus:border-electric-blue focus:ring-electric-blue"
                >
                  <option value="">{tr('Choose a part of speech', '请选择词性')}</option>
                  <option value="n.">{tr('Noun', '名词')} (n.)</option>
                  <option value="v.">{tr('Verb', '动词')} (v.)</option>
                  <option value="adj.">{tr('Adjective', '形容词')} (adj.)</option>
                  <option value="adv.">{tr('Adverb', '副词')} (adv.)</option>
                  <option value="pron.">{tr('Pronoun', '代词')} (pron.)</option>
                  <option value="prep.">{tr('Preposition', '介词')} (prep.)</option>
                  <option value="conj.">{tr('Conjunction', '连词')} (conj.)</option>
                  <option value="int.">{tr('Interjection', '感叹词')} (int.)</option>
                  <option value="art.">{tr('Article', '冠词')} (art.)</option>
                  <option value="det.">{tr('Determiner', '限定词')} (det.)</option>
                  <option value="aux.">{tr('Auxiliary verb', '助动词')} (aux.)</option>
                  <option value="phr.">{tr('Phrase', '短语')} (phr.)</option>
                  <option value="other">{tr('Other', '其他')}</option>
                </select>
              </label>
              <label className="block text-sm font-semibold text-text-light">
                {tr('Chinese meaning', '中文释义')}
                <input
                  required
                  value={pendingMeaningSelection.meaningZh}
                  onChange={event => setPendingMeaningSelection(prev => prev ? { ...prev, meaningZh: event.target.value } : prev)}
                  onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
                  placeholder={tr('Type the Chinese meaning', '请输入中文释义')}
                  className="mt-2 block w-full rounded-xl border border-white/20 bg-[#1c2028] px-4 py-3 text-white placeholder:text-text-dark focus:border-electric-blue focus:ring-electric-blue"
                />
              </label>
              {pendingMeaningSelection.meaningZh.trim() && !normalizeChineseMeaning(pendingMeaningSelection.meaningZh) && (
                <p role="alert" className="text-sm text-amber-300">{tr('Please enter a Chinese meaning.', '请输入包含中文的释义。')}</p>
              )}
            </div>
            <div className="mt-6 flex items-center justify-end gap-3 border-t border-white/10 pt-4">
              {pendingMeaningSelection.editingTempId && (
                <button type="button" onClick={() => setPendingMeaningSelection(null)} className="rounded-xl border border-white/20 px-5 py-3 text-sm text-text-light hover:bg-white/10">{tr('Cancel', '取消')}</button>
              )}
              <button
                type="submit"
                disabled={!pendingMeaningSelection.partOfSpeech || !normalizeChineseMeaning(pendingMeaningSelection.meaningZh)}
                className="rounded-xl bg-amber-300 px-5 py-3 font-mono text-sm font-bold uppercase tracking-[0.2em] text-[#111318] transition-all hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tr('Save meaning', '保存释义')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Word Delete Confirmation Modal */}
      {wordToDelete && (
        <div 
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[80] flex items-center justify-center p-6 animate-in fade-in duration-300"
            onClick={(e) => {
                console.log("🎯 Backdrop clicked", e.target);
                // 只在点击背景时关闭，不影响内部点击
                if (e.target === e.currentTarget) {
                    setWordToDelete(null);
                }
            }}
        >
            <div 
                className="bg-light-charcoal border border-red-500/50 rounded-3xl p-8 max-w-[400px] w-full shadow-[0_0_30px_rgba(239,68,68,0.2)] scale-in-center"
                onClick={(e) => {
                    console.log("📦 Modal content clicked", e.target);
                    e.stopPropagation(); // 阻止冒泡到背景
                }}
            >
                <h3 className="text-xl font-headline text-white mb-2"><HoverTranslationText text="REMOVE WORD?" translation="要移除这个单词吗？" /></h3>
                <p className="text-text-dark mb-6 text-sm">
                    {tr('Remove', '确定移除')} <span className="text-electric-blue font-bold">"{wordToDelete.item.text}"</span>{tr('?', '？')}
                    {wordToDelete.item.id && tr(' This permanently deletes it from your library.', ' 这会将其从单词库中永久删除。')}
                </p>
                <div className="flex gap-4">
                    <button 
                        onClick={() => {
                            console.log("❌ Cancel delete clicked");
                            setWordToDelete(null);
                        }}
                        className="flex-1 py-3 rounded-xl bg-dark-charcoal text-text-light hover:bg-white hover:text-charcoal transition-colors font-mono text-xs uppercase"
                        type="button"
                    >
                        <HoverTranslationText text="Cancel" translation="取消" />
                    </button>
                    <button 
                        onClick={(e) => {
                            console.log("🔴 DELETE button clicked", e);
                            console.log("🔴 Event target:", e.target);
                            console.log("🔴 Event currentTarget:", e.currentTarget);
                            confirmDelete();
                        }}
                        onMouseDown={() => console.log("🖱️ DELETE button mousedown")}
                        onMouseEnter={() => console.log("🖱️ DELETE button hover")}
                        className="flex-1 py-3 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors font-headline tracking-wider text-sm shadow-lg"
                        type="button"
                    >
                        <HoverTranslationText text="DELETE" translation="删除" />
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Unsaved Changes Warning Modal */}
      {showUnsavedWarning && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-6 animate-in fade-in duration-300">
            <div className="bg-light-charcoal border border-electric-blue/50 rounded-3xl p-8 max-w-[500px] w-full shadow-[0_0_30px_rgba(0,240,255,0.2)] scale-in-center">
                <div className="flex items-center gap-3 mb-4">
                    <span className="material-symbols-outlined text-4xl text-electric-blue">warning</span>
                    <h3 className="text-2xl font-headline text-white tracking-tight"><HoverTranslationText text="UNSAVED CHANGES" translation="未保存的更改" /></h3>
                </div>
                
                <p className="text-text-light mb-2 text-sm leading-relaxed">
                    {tr("You have unsaved changes in this session. What would you like to do?", "本批次有尚未保存的更改，请选择后续操作。")}
                </p>
                <p className="text-text-dark font-mono text-xs mb-8 p-4 bg-dark-charcoal rounded-xl border border-mid-charcoal">
                    {currentWords.filter(w => !w.id).length > 0 && tr(`${currentWords.filter(w => !w.id).length} new word(s) added. `, `新增 ${currentWords.filter(w => !w.id).length} 个单词。`)}
                    {(initialWords.length - currentWords.filter(w => w.id).length) > 0 && tr(`${initialWords.length - currentWords.filter(w => w.id).length} word(s) removed.`, `移除 ${initialWords.length - currentWords.filter(w => w.id).length} 个单词。`)}
                </p>
                
                <div className="grid gap-3">
                    <button 
                        onClick={async () => {
                            setShowUnsavedWarning(false);
                            await handleSubmitSession();
                        }}
                        disabled={!!targetWord || !!familyQueue || !!pendingMeaningSelection}
                        className="w-full py-4 rounded-xl bg-electric-green text-charcoal hover:bg-white transition-all font-headline tracking-wider text-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        <span className="material-symbols-outlined">save</span>
                        {targetWord || familyQueue ? <HoverTranslationText text="FINISH WORD FIRST" translation="请先完成当前单词" /> : pendingMeaningSelection ? <HoverTranslationText text="SELECT MEANING FIRST" translation="请先选择释义" /> : <HoverTranslationText text="SAVE & UPDATE" translation="保存并更新" />}
                    </button>
                    <button 
                        onClick={() => {
                            setShowUnsavedWarning(false);
                            onCancel();
                        }}
                        className="w-full py-4 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-all font-headline tracking-wider shadow-lg"
                    >
                        <HoverTranslationText text="DISCARD CHANGES" translation="放弃更改" />
                    </button>
                    <button 
                        onClick={() => setShowUnsavedWarning(false)}
                        className="w-full py-3 rounded-xl bg-mid-charcoal text-text-light hover:bg-white hover:text-charcoal transition-colors font-mono text-xs uppercase tracking-widest"
                    >
                        {tr("CANCEL (KEEP EDITING)", "取消（继续编辑）")}
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

// --- Test Mode Component ---
const TestMode: React.FC<{ 
  allWords: WordEntry[];
  allSessions: InputSession[];
  initialSessionIds: string[];
  initialWordIds?: string[];
  onComplete: (results: { id: string; correct: boolean }[]) => void;
  onCancel: () => void;
}> = ({ allWords, initialSessionIds, initialWordIds, onComplete, onCancel }) => {
  const { isZh } = useLanguage();
  const tr = (en: string, zh: string) => isZh ? zh : en;
  const t = useT();
  const [queue, setQueue] = useState<WordEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [feedback, setFeedback] = useState<'NONE' | 'CORRECT' | 'WRONG'>('NONE');
  const [results, setResults] = useState<{ id: string; correct: boolean }[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  useEffect(() => {
    let selected: WordEntry[] = [];
    if (initialWordIds && initialWordIds.length > 0) {
      selected = allWords.filter(w => initialWordIds.includes(w.id));
    } else if (initialSessionIds.length > 0) {
      selected = allWords.filter(w => initialSessionIds.includes(w.sessionId));
    } else {
        selected = [];
    }

    const shuffled = [...selected];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setQueue(shuffled);
  }, [initialSessionIds, initialWordIds, allWords]);

  const currentWord = queue[currentIndex];

  const handlePlayAudio = async () => {
      if (!currentWord || isPlayingAudio) return;
      setIsPlayingAudio(true);
      try {
          const audio = await aiService.generateSpeech(currentWord.text);
          if (audio) {
              if (typeof audio === 'string') {
                  const u = new SpeechSynthesisUtterance(audio);
                  window.speechSynthesis.speak(u);
              } else {
                  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
                  const source = ctx.createBufferSource();
                  source.buffer = audio;
                  source.connect(ctx.destination);
                  source.start(0);
              }
          }
      } catch (e) {
          console.error("Audio playback error", e);
      } finally {
          setIsPlayingAudio(false);
      }
  };

  const checkAnswer = () => {
      if (!currentWord) return;
      const normalizedInput = inputValue.trim().toLowerCase();
      const normalizedTarget = currentWord.text.trim().toLowerCase();

      if (normalizedInput === normalizedTarget) {
          setFeedback('CORRECT');
          playDing();
      } else {
          setFeedback('WRONG');
          playBuzzer();
      }
  };

  const handleNext = (success: boolean) => {
      const newResults = [...results, { id: currentWord.id, correct: success }];
      setResults(newResults);
      
      if (currentIndex >= queue.length - 1) {
          setIsFinished(true);
      } else {
          setCurrentIndex(prev => prev + 1);
          setInputValue('');
          setFeedback('NONE');
      }
  };

  useEffect(() => {
      if (feedback === 'CORRECT') {
          const t = setTimeout(() => {
              handleNext(true);
          }, 1500);
          return () => clearTimeout(t);
      }
  }, [feedback]);

  useEffect(() => {
      if (currentWord && feedback === 'NONE' && !isFinished) {
          const t = setTimeout(() => handlePlayAudio(), 500);
          return () => clearTimeout(t);
      }
  }, [currentWord, feedback, isFinished]);


  if (queue.length === 0) {
      return (
          <div className="flex flex-col items-center justify-center min-h-[50vh] text-text-dark">
              <span className="material-symbols-outlined text-4xl mb-4 animate-spin">sync</span>
              <p>{tr("Preparing neural pathways...", "正在准备测验…")}</p>
          </div>
      );
  }

  if (isFinished) {
      const correctCount = results.filter(r => r.correct).length;
      const isPerfect = correctCount === queue.length;

      return (
          <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in zoom-in duration-500">
              {isPerfect && <Confetti />}
              <h2 className="font-headline text-6xl text-white mb-4">{tr("SESSION COMPLETE", "测验完成")}</h2>
              <div className="text-9xl font-mono text-electric-blue mb-8 drop-shadow-[0_0_15px_rgba(0,240,255,0.5)]">
                  {Math.round((correctCount / queue.length) * 100)}%
              </div>
              <p className="text-text-dark mb-8 text-xl">
                  {t.correctOutOf(correctCount, queue.length)}
              </p>
              <button 
                  onClick={() => onComplete(results)}
                  className="px-10 py-4 bg-mid-charcoal hover:bg-electric-green hover:text-charcoal text-white rounded-xl font-headline text-2xl transition-all"
              >
                  {t.returnToDashboard}
              </button>
          </div>
      );
  }

  return (
      <div className="max-w-3xl mx-auto py-8 px-4 flex flex-col items-center gap-8 relative">
          <div className="w-full flex items-center gap-4">
              <button onClick={onCancel} className="p-2 rounded-full hover:bg-mid-charcoal text-text-dark transition-colors">
                  <span className="material-symbols-outlined">close</span>
              </button>
              <div className="flex-1 h-2 bg-mid-charcoal rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-electric-blue transition-all duration-500"
                    style={{ width: `${(currentIndex / queue.length) * 100}%` }}
                  ></div>
              </div>
              <span className="font-mono text-xs text-text-dark">{currentIndex + 1}/{queue.length}</span>
          </div>

          <div className="w-full bg-light-charcoal rounded-3xl border border-mid-charcoal p-8 shadow-2xl flex flex-col items-center gap-8 relative overflow-hidden">
             <div className="relative w-full aspect-video bg-dark-charcoal rounded-2xl overflow-hidden group border border-mid-charcoal">
                 {currentWord.image_url ? (
                     <img 
                        src={currentWord.image_url} 
                        className={`w-full h-full object-cover transition-all duration-700 ${feedback === 'WRONG' ? 'blur-0' : 'blur-lg group-hover:blur-md'}`}
                        alt={tr("Hint", "提示图片")}
                     />
                 ) : (
                     <div className="w-full h-full flex items-center justify-center opacity-20">
                         <span className="material-symbols-outlined text-6xl">image</span>
                     </div>
                 )}
                 
                 <div className="absolute inset-0 flex items-center justify-center">
                      <button 
                          onClick={handlePlayAudio}
                          className="p-6 bg-black/40 hover:bg-electric-blue hover:text-charcoal backdrop-blur-sm rounded-full border border-white/20 transition-all transform hover:scale-110 text-white"
                      >
                          <span className="material-symbols-outlined text-5xl">{isPlayingAudio ? 'volume_up' : 'play_arrow'}</span>
                      </button>
                 </div>
             </div>

             <div className="w-full relative min-h-[150px] flex items-center justify-center">
                 {feedback === 'WRONG' ? (
                     <div className="text-center animate-in fade-in slide-in-from-bottom-4 w-full">
                         <p className="text-red-400 font-mono text-sm uppercase mb-2">{tr("Correction", "正确答案")}</p>
                         <h3 className="text-4xl md:text-5xl font-serif text-white mb-6 tracking-wide">{currentWord.text}</h3>
                         <button 
                            onClick={() => handleNext(false)}
                            className="px-8 py-3 bg-mid-charcoal border border-mid-charcoal hover:border-text-light text-white rounded-xl transition-all"
                         >
                             {tr("Got it", "记住了")}
                         </button>
                     </div>
                 ) : feedback === 'CORRECT' ? (
                     <div className="text-center animate-in zoom-in duration-300">
                         <span className="material-symbols-outlined text-8xl text-electric-green mb-2">check_circle</span>
                         <h3 className="text-2xl font-headline text-white">{tr("CORRECT", "答对了")}</h3>
                     </div>
                 ) : (
                     <LargeWordInput 
                        value={inputValue}
                        onChange={setInputValue}
                        onEnter={checkAnswer}
                        placeholder={tr("Type word...", "输入单词…")}
                     />
                 )}
             </div>

             {feedback === 'NONE' && (
                 <button 
                    onClick={checkAnswer}
                    disabled={!inputValue.trim()}
                    className="px-12 py-4 bg-electric-blue text-charcoal font-headline text-2xl rounded-xl hover:bg-white transition-all transform active:scale-95 disabled:opacity-50 disabled:transform-none"
                 >
                     {tr("CHECK", "检查答案")}
                 </button>
             )}
          </div>
      </div>
  );
};

export default App;
