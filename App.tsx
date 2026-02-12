import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabaseClient';
import { Auth } from './components/Auth';
import { PasswordReset } from './components/PasswordReset';
import { PasswordForgotRequest } from './components/PasswordForgotRequest';
import { fetchUserData, fetchUserStats, saveSessionData, modifySession, updateWordStatus, getImageUrl, uploadImage, updateWordImage, updateWordStatusV2, deleteSessions, fetchUserAchievements, saveUserAchievement, DeleteProgress, recordTestAndSyncStats } from './services/dataService';
import {
  loadLocalBackup,
  saveLocalBackup,
  saveSessionToLocal,
  deleteSessionFromLocal,
  syncSessionToCloud,
  resolveConflict,
  syncAllPendingSessions,
  SessionWithSync,
  SyncStatus,
  SyncResult
} from './services/syncService';
import { AppMode, WordEntry, InputSession, DayStats } from './types';
import { LargeWordInput } from './components/LargeWordInput';
import { CalendarView } from './components/CalendarView';
import { Confetti } from './components/Confetti';
import TestModeV2 from './components/TestModeV2';
import { aiService } from './services/ai';
import { fetchDictionaryData, playWordAudio as playWordAudioService } from './services/dictionaryService';
import { playDing, playBuzzer, playAchievementUnlock } from './utils/audioFeedback';
import { AchievementsPanel } from './components/Achievements/AchievementsPanel';
import { calculateAchievements, ACHIEVEMENTS, Achievement } from './services/achievementService';
import { AchievementUnlockModal } from './components/Achievements/AchievementUnlockModal.tsx';
// import { generateImagesForMissingWords } from './services/imageGenerationTask';
import { AccountPanel } from './components/AccountPanel';
import { LandingPage } from './components/LandingPage';
import { LibrarySelector } from './components/LibrarySelector';
import { AdminConsole } from './components/AdminConsole';


// Define Test Configuration State
interface TestConfig {
  sessionIds?: string[];
  wordIds?: string[];
}

const App: React.FC = () => {
  const [session, setSession] = useState<any>(null);
  const [showLanding, setShowLanding] = useState(true);
  const [mode, setMode] = useState<AppMode>('DASHBOARD');

  // 通知系统
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'warning' | 'error' } | null>(null);

  const showNotification = (message: string, type: 'success' | 'warning' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 5000); // 5秒后自动消失
  };

  // 同步状态
  const [syncingSessionId, setSyncingSessionId] = useState<string | null>(null);
  const [conflictModal, setConflictModal] = useState<{
    sessionId: string;
    cloud: InputSession;
    local: InputSession;
  } | null>(null);
  const [words, setWords] = useState<WordEntry[]>([]);
  const [sessions, setSessions] = useState<InputSession[]>([]);
  const [dailyStats, setDailyStats] = useState<Record<string, DayStats>>({});
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // Edit Mode State
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  
  // Test Mode Configuration State
  const [testConfig, setTestConfig] = useState<TestConfig | null>(null);
  const [showQuickTestModal, setShowQuickTestModal] = useState(false);
  
  // Multi-Select State for Dashboard Testing
  const [selectedDashboardSessionIds, setSelectedDashboardSessionIds] = useState<Set<string>>(new Set());

  // Delete Confirmation State
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [idsToDelete, setIdsToDelete] = useState<string[]>([]);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Admin Console State
  const [showAdminConsole, setShowAdminConsole] = useState(false);

  // Password Reset State
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [showPasswordForgot, setShowPasswordForgot] = useState(false);

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle Admin Console with `~` or Backtick
      if (e.key === '`' || e.key === '~') {
          // If inputting text, maybe allow it? But `~` is rarely used in standard inputs except code.
          // Check if active element is input
          const tag = document.activeElement?.tagName.toLowerCase();
          if (tag !== 'input' && tag !== 'textarea') {
              setShowAdminConsole(prev => !prev);
          }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  
  // Achievement State
  const [unlockedAchievements, setUnlockedAchievements] = useState<Set<string>>(new Set());
  const [achievementQueue, setAchievementQueue] = useState<Achievement[]>([]);
  const [isReconciled, setIsReconciled] = useState(false);
  const [showAccountPanel, setShowAccountPanel] = useState(false);
  
  // Filtered Data for View (Soft Delete Logic)
  const visibleSessions = useMemo(() => sessions.filter(s => !s.deleted), [sessions]);
  const visibleWords = useMemo(() => words.filter(w => !w.deleted), [words]);

  // Auth Listener
  useEffect(() => {
    if (!isSupabaseConfigured) return;

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);

      // Check if user's email is confirmed after login/signup
      if (session?.user && !session.user.email_confirmed_at) {
        // Only show this warning if we haven't already shown it for this user
        const notificationKey = `email-warning-shown-${session.user.id}`;
        if (!localStorage.getItem(notificationKey)) {
          setTimeout(() => {
            showNotification(
              '⚠️ Please confirm your email address! Check your inbox (including spam folder) to activate your account.',
              'warning',
              10000
            );
          }, 1000);
          localStorage.setItem(notificationKey, 'true');
        }
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Fetch Data on Login
  const refreshData = useCallback(() => {
    if (session?.user) {
      setLoadingData(true);
      setDataError(null);
      Promise.all([
          fetchUserData(session.user.id),
          fetchUserStats(session.user.id),
          fetchUserAchievements(session.user.id)
      ])
        .then(([{ sessions, words }, stats, achievementIds]) => {
          setSessions(sessions);
          setWords(words);

          // Initialize Achievements (DB Load)
          setUnlockedAchievements(new Set(achievementIds));

          // Map DB daily_stats array to Record<string, DayStats>
          const statsMap: Record<string, DayStats> = {};
          stats.forEach((s: any) => {
              statsMap[s.date] = {
                  date: s.date,
                  total: s.total_count || s.total,  // Use total_count from DB
                  correct: s.correct_count || s.correct,  // Use correct_count from DB
                  // FIXED: Use total_points first (new accurate field), fallback to legacy points
                  points: s.total_points ?? s.points ?? 0,
                  is_frozen: s.is_frozen || false  // Include freeze status
              };
          });
          setDailyStats(statsMap);
        })
        .catch((err) => {
            console.error("Data load error:", err);
            setDataError("Failed to fetch data from the cloud. Please check your connection.");
        })
        .finally(() => setLoadingData(false));
    }
  }, [session]);

  useEffect(() => {
      refreshData();
  }, [refreshData]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setWords([]);
    setSessions([]);
    setDailyStats({});
    setUnlockedAchievements(new Set());
    setAchievementQueue([]);
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
    if (loadingData || isReconciled) return;

    // We also need to make sure we actually have loaded data. 
    // If sessions/words are empty but loadingData is false, it might mean empty account OR failed load.
    // But assuming successful empty load is fine, reconciliation is fast.
    
    // NOTE: This runs even if sessions/words are emptySets, which is correct (clears nothing, adds nothing).

    const currentCalculated = calculateAchievements(words, sessions);
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
            });
        } else {
            console.error("Phase 1: Cannot save, no user session");
        }
    }

    // Mark as reconciled so we can start listening for REAL new events
    setIsReconciled(true);
    
  }, [loadingData, isReconciled, words, sessions, unlockedAchievements, session]);


  // Achievement Tracking (Phase 2: Live Events)
  useEffect(() => {
    // Block until reconciliation is complete to avoid "double-counting" historical achievements
    if (loadingData || !isReconciled) return;

    const currentStatuses = calculateAchievements(words, sessions);

    // Check for NEW unlocks only (compare with what we already have in state)
    // Since we are Reconciled, any difference here is a GENUINE new event.
    currentStatuses.forEach(status => {
        if (status.unlocked && !unlockedAchievements.has(status.id)) {
            const ach = ACHIEVEMENTS.find(a => a.id === status.id);
            if (ach) {
                // 1. Add to queue (Celebration!)
                setAchievementQueue(prev => [...prev, ach]);
                playAchievementUnlock();

                // 2. Update local state
                setUnlockedAchievements(prev => {
                    const next = new Set(prev);
                    next.add(status.id);
                    return next;
                });
                
                // 3. Persist to DB
                if (session?.user?.id) {
                    saveUserAchievement(session.user.id, status.id);
                }
            }
        }
    });
  }, [words, sessions, loadingData, unlockedAchievements, session, isReconciled]);

  // Derived Stats (Merged: DB History + Live Local Updates)
  // We use the DB loaded stats as base.
  // Note: Since we "fire & forget" sync stats on update, local state might be slightly ahead or behind 
  // until next refresh, but for UX responsiveness we can rely on dailyStats state 
  // which we should update locally when tests finish.
  const getStats = (): Record<string, DayStats> => {
    return dailyStats;
  };
  
  // ✨ NEW: Helper to update stats with incremental recording
  // This uses the new daily_test_records table for accurate incremental statistics
  const updateLocalStats = async (results: { correct: boolean; score: number }[]) => {
      // CRITICAL: Use client's local timezone for consistency with calendar view
      const d = new Date();
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const today = `${year}-${month}-${day}`;

      // Calculate test results
      const correctCount = results.filter(r => r.correct).length;
      const currentTestPoints = results.reduce((sum, r) => sum + (r.score || 0), 0);

      console.log(`[updateLocalStats] Recording test: ${results.length} words, ${correctCount} correct, ${currentTestPoints} points`);

      // Update local stats immediately for instant UI feedback (optimistic update)
      setDailyStats(prev => {
          const current = prev[today] || { date: today, total: 0, correct: 0, points: 0 };
          return {
              ...prev,
              [today]: {
                  date: today,
                  total: current.total + results.length,
                  correct: current.correct + correctCount,
                  points: current.points + currentTestPoints
              }
          };
      });

      // 🔄 Record test to database and wait for confirmation
      if (session?.user) {
          try {
              const dbStats = await recordTestAndSyncStats(
                  results.length,
                  correctCount,
                  currentTestPoints
              );

              if (dbStats) {
                  console.log('[updateLocalStats] ✅ Database sync completed:', dbStats);

                  // Update local state with accurate database values
                  // The database now returns CORRECT incremental statistics!
                  setDailyStats(prev => {
                      const newStats = { ...prev };
                      newStats[today] = {
                          date: today,
                          total: dbStats.total_tests || results.length,
                          correct: dbStats.correct_tests || correctCount,
                          points: dbStats.total_points || currentTestPoints
                      };
                      return newStats;
                  });
              } else {
                  console.warn('[updateLocalStats] ⚠️ Database returned null, keeping local optimistic update');
              }
          } catch (err) {
              console.error('[updateLocalStats] ❌ Failed to sync with database:', err);
              // Keep local optimistic update on error
          }
      }
  };

  // ☁️ Sync Status Checker - Check localStorage and update sessions with sync status
  useEffect(() => {
    // Wait for data to be fully loaded
    if (loadingData) return;

    // Only run when we have sessions
    if (sessions.length === 0) return;

    console.log('[SyncStatusChecker] Checking sync status for loaded sessions...');

    // Load local backup from localStorage
    const localBackup = loadLocalBackup();

    // Create a map of sessions in local backup for quick lookup
    const localBackupMap = new Map<string, 'synced' | 'pending' | 'failed'>();

    if (localBackup && localBackup.sessions.length > 0) {
      // Mark sessions that exist in local backup
      localBackup.sessions.forEach(s => {
        localBackupMap.set(s.id, s.syncStatus);
        console.log(`[SyncStatusChecker] Found in local backup: ${s.id} -> ${s.syncStatus}`);
      });
    }

    // Update sessions with sync status
    setSessions(prev => prev.map(s => {
      const syncStatus = localBackupMap.get(s.id);
      if (syncStatus) {
        // Session exists in local backup, use its status
        console.log(`[SyncStatusChecker] Session ${s.id}: ${syncStatus}`);
        return { ...s, syncStatus };
      } else {
        // Session not in local backup, assume it's synced
        console.log(`[SyncStatusChecker] Session ${s.id}: synced (not in backup)`);
        return { ...s, syncStatus: 'synced' as const };
      }
    }));
  }, [loadingData, sessions.length]); // Depend on loading completion and sessions array

  // Background Process
  const processBackgroundData = async (userId: string, wordsToProcess: any[]) => {
    if (!wordsToProcess || !Array.isArray(wordsToProcess)) return;
    for (const w of wordsToProcess) {
        // 1. Process Images
        /*
        if (!w.image_path) {
            try {
                const base64 = await aiService.generateImageHint(w.text);
                if (base64) {
                    const path = await uploadImage(base64, userId);
                    if (path) {
                        await updateWordImage(w.id, path);
                        setWords(prev => prev.map(word => 
                            word.id === w.id 
                            ? { ...word, image_path: path, image_url: getImageUrl(path) } 
                            : word
                        ));
                    }
                }
            } catch (e) {
                console.warn(`Background image generation failed for ${w.text}:`, e);
            }
        }
        */

        // 2. Process Dictionary Info (Phonetic, Audio, Definition)
        try {
            const dict = await fetchDictionaryData(w.text, w.language || 'en');
            if (dict) {
                await updateWordStatusV2(w.id, {
                    correct: w.correct || false,
                    phonetic: dict.phonetic,
                    audio_url: dict.audioUrl,
                    language: w.language || 'en',
                    definition_en: dict.definition_en
                });
                
                // Update local state if word still exists
                setWords(prev => prev.map(word => 
                    word.id === w.id 
                    ? { ...word, phonetic: dict.phonetic || null, audio_url: dict.audioUrl || null, language: w.language || 'en', definition_en: dict.definition_en || null } 
                    : word
                ));
            }
        } catch (e) {
            console.warn(`Background dictionary fetch failed for ${w.text}:`, e);
        }
    }
  };

  // Handle Save (New Session or Update Existing)
  const handleSaveSession = async (
    wordList: { id?: string, text: string, imageBase64?: string }[], 
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
             
             return textChanged || hasNewImage;
        }).map(w => ({
            id: w.id!,
            text: w.text,
            imageBase64: w.imageBase64
        }));

        const { newWordsData } = await modifySession(session.user.id, editingSessionId, addedWords, deletedIds, updatedWords);
        
        newWordsData.forEach((w: any) => idsToProcess.add(w.id));
        updatedWords.forEach(w => idsToProcess.add(w.id));

      } else {
        // CREATE NEW SESSION
        const { wordsData } = await saveSessionData(session.user.id, wordList.length, wordList);
        wordsData.forEach((w: any) => idsToProcess.add(w.id));
      }
      
      // RELOAD DATA IMMEDIATELY (Blocking)
      // This ensures that when we switch to dashboard, the data is FRESH.
      const { sessions: dashboardSessions, words: dashboardWords } = await fetchUserData(session.user.id);
      setSessions(dashboardSessions);
      setWords(dashboardWords);

      setMode('DASHBOARD');
      setEditingSessionId(null);

      // Trigger Background Process
      const wordsToProcess = dashboardWords.filter(w => idsToProcess.has(w.id));
      processBackgroundData(session.user.id, wordsToProcess);

      // ✅ 成功保存到云端，清除本地备份
      if (editingSessionId) {
        const localBackup = loadLocalBackup();
        if (localBackup) {
          const updatedBackup = {
            ...localBackup,
            sessions: localBackup.sessions.filter(s => s.id !== editingSessionId)
          };
          saveLocalBackup(updatedBackup);
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
          definition_cn: existingWord?.definition_cn || null,
          definition_en: existingWord?.definition_en || null,
          deleted: false,
          tags: ['Custom']
        };
      });

      // 保存到本地
      saveSessionToLocal(sessionData, wordsData, 'pending');

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
      showNotification('⚠️ Saved locally due to connection error. Will auto-sync when connection is restored.', 'warning');
    }
  };

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
          alert("Failed to delete sessions. Check console.");
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
          alert("Failed to delete word: " + (e as Error).message);
      }
  };

  // ☁️ Manual Sync Handler
  const handleManualSync = async (sessionId: string) => {
    if (!session?.user) {
      showNotification('请先登录', 'error');
      return;
    }

    setSyncingSessionId(sessionId);

    try {
      // 从本地备份获取数据
      const localBackup = loadLocalBackup();
      const localSession = localBackup?.sessions.find(s => s.id === sessionId);
      const localWords = localBackup?.words.filter(w => w.sessionId === sessionId);

      if (!localSession || !localWords) {
        // 如果本地备份中没有，可能已经在云端了，尝试从云端刷新
        showNotification('该 Session 未找到本地备份数据，正在从云端刷新...', 'warning');
        const { sessions: cloudSessions, words: cloudWords } = await fetchUserData(session.user.id);
        setSessions(cloudSessions);
        setWords(cloudWords);
        showNotification('✅ 数据已从云端刷新', 'success');
        return;
      }

      console.log(`[ManualSync] Syncing session ${sessionId}...`);

      // 调用同步服务
      const result = await syncSessionToCloud(
        session.user.id,
        localSession,
        localWords
      );

      if (result.success) {
        if (result.action === 'uploaded') {
          // 上传成功 → 清除本地备份
          const updatedBackup = {
            ...localBackup!,
            sessions: localBackup!.sessions.filter(s => s.id !== sessionId)
          };
          saveLocalBackup(updatedBackup);

          // 刷新数据
          const { sessions: cloudSessions, words: cloudWords } = await fetchUserData(session.user.id);
          setSessions(cloudSessions);
          setWords(cloudWords);

          showNotification('✅ 同步成功！数据已上传到云端', 'success');
        } else if (result.action === 'downloaded') {
          // 云端较新 → 应用云端数据
          if (result.cloudData) {
            setSessions(prev => prev.map(s =>
              s.id === sessionId ? { ...result.cloudData!.session, syncStatus: 'synced' as const } : s
            ));
            setWords(prev => {
              const oldIds = prev
                .filter(w => w.sessionId === sessionId)
                .map(w => w.id);
              const newWords = result.cloudData!.words.filter(
                w => !oldIds.has(w.id)
              );
              return [...prev.filter(w => !oldIds.has(w.id)), ...newWords];
            });

            // 清除本地备份
            const updatedBackup = {
              ...localBackup!,
              sessions: localBackup!.sessions.filter(s => s.id !== sessionId)
            };
            saveLocalBackup(updatedBackup);
          }
          showNotification('📥 已应用云端最新数据', 'success');
        } else if (result.action === 'skipped') {
          // 数据相同，确保 syncStatus 为 synced
          setSessions(prev => prev.map(s =>
            s.id === sessionId ? { ...s, syncStatus: 'synced' as const } : s
          ));
          showNotification('✅ 数据已同步，无需操作', 'success');
        }
      } else {
        // 同步失败/冲突 → 更新 syncStatus 为 failed
        console.error('[ManualSync] Sync failed:', result.action, result.message);

        // 更新本地备份的 syncStatus
        const updatedBackup = {
          ...localBackup!,
          sessions: localBackup!.sessions.map(s =>
            s.id === sessionId ? { ...s, syncStatus: 'failed' as const } : s
          )
        };
        saveLocalBackup(updatedBackup);

        // 更新当前 session 的 syncStatus
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, syncStatus: 'failed' as const } : s
        ));

        if (result.action === 'conflict' && result.conflictData) {
          setConflictModal({
            sessionId,
            cloud: result.conflictData.cloud,
            local: result.conflictData.local
          });
        } else {
          showNotification(`❌ 同步失败: ${result.message}`, 'error');
        }
      }
    } catch (error) {
      console.error('[ManualSync] Error:', error);
      showNotification(`❌ 同步失败: ${(error as Error).message}`, 'error');
    } finally {
      setSyncingSessionId(null);
    }
  };

  // ⚖️ Conflict Resolution Handler
  const handleConfirmConflictResolution = async () => {
    if (!conflictModal || !conflictChoice || !session?.user) return;

    try {
      const result = await resolveConflict(
        session.user.id,
        conflictModal.sessionId,
        conflictChoice,
        {
          session: conflictModal.local,
          words: [] // Words will be fetched separately
        },
        {
          session: conflictModal.cloud,
          words: []
        }
      );

      if (result.success) {
        // 清除冲突标记
        setConflictModal(null);
        setConflictChoice(null);

        // 刷新数据
        const { sessions: cloudSessions, words: cloudWords } = await fetchUserData(session.user.id);
        setSessions(cloudSessions);
        setWords(cloudWords);

        // 清除本地备份
        const localBackup = loadLocalBackup();
        if (localBackup) {
          const updatedBackup = {
            ...localBackup,
            sessions: localBackup.sessions.filter(s => s.id !== conflictModal.sessionId)
          };
          saveLocalBackup(updatedBackup);
        }

        showNotification('✅ 冲突已解决！', 'success');
      } else {
        showNotification(`❌ 解决冲突失败: ${result.message}`, 'error');
      }
    } catch (error) {
      console.error('[ConflictResolution] Error:', error);
      showNotification(`❌ 解决冲突失败: ${(error as Error).message}`, 'error');
    }
  };

  // 🔄 Auto Sync (30 minutes)
  useEffect(() => {
    if (!session?.user) return;

    const interval = setInterval(async () => {
      const backup = loadLocalBackup();
      if (!backup) return;

      const pendingSessions = backup.sessions.filter(
        s => s.syncStatus === 'pending' || s.syncStatus === 'failed'
      );

      if (pendingSessions.length === 0) return;

      console.log(`[AutoSync] Found ${pendingSessions.length} pending sessions`);

      const result = await syncAllPendingSessions(session.user.id);
      console.log(
        `[AutoSync] Complete: ${result.synced} synced, ${result.failed} failed, ${result.conflicts} conflicts`
      );

      // 更新本地状态
      if (result.synced > 0 || result.conflicts > 0) {
        const { sessions: cloudSessions, words: cloudWords } =
          await fetchUserData(session.user.id);
        setSessions(cloudSessions);
        setWords(cloudWords);

        if (result.synced > 0) {
          showNotification(
            `✅ 自动同步完成：${result.synced} 个 Session 已同步`,
            'success'
          );
        }
      }

      // 处理冲突
      if (result.conflicts > 0) {
        showNotification(
          `⚠️ 检测到 ${result.conflicts} 个同步冲突，请手动处理`,
          'warning'
        );
      }
    }, 30 * 60 * 1000); // 30分钟

    return () => clearInterval(interval);
  }, [session?.user]);

  // 🌐 Network Status Listener
  useEffect(() => {
    const handleOnline = async () => {
      console.log('🌐 Network restored, attempting to sync...');
      showNotification('🌐 网络已恢复，正在同步...', 'success');

      // 立即尝试同步所有待同步的Session
      const backup = loadLocalBackup();
      if (backup && session?.user) {
        const pendingSessions = backup.sessions.filter(
          s => s.syncStatus === 'pending' || s.syncStatus === 'failed'
        );

        if (pendingSessions.length > 0) {
          const result = await syncAllPendingSessions(session.user.id);
          if (result.synced > 0) {
            const { sessions: cloudSessions, words: cloudWords } =
              await fetchUserData(session.user.id);
            setSessions(cloudSessions);
            setWords(cloudWords);
          }
        }
      }
    };

    const handleOffline = () => {
      console.log('📴 Network lost, switching to offline mode');
      showNotification(
        '⚠️ 网络断开，数据将保存到本地',
        'warning'
      );
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [session?.user]);

  const handleStartEdit = (sessionId: string) => {
    setEditingSessionId(sessionId);
    setMode('INPUT');
  };

  const handleStartTest = (sessionIds: string[]) => {
    setTestConfig({ sessionIds });
    setMode('TEST');
  };

  const handleStartTestFromLibrary = (wordIds: string[]) => {
    setTestConfig({ wordIds });
    setMode('TEST');
  };

  if (!isSupabaseConfigured) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dark-charcoal p-4 text-center animate-in fade-in duration-700">
        <span className="material-symbols-outlined text-6xl text-red-500 mb-6 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]">cloud_off</span>
        <h1 className="font-headline text-4xl text-white mb-4 tracking-wider">NEURAL LINK SEVERED</h1>
        <div className="bg-light-charcoal border border-mid-charcoal p-6 rounded-2xl max-w-lg shadow-2xl">
          <p className="font-mono text-text-dark text-sm mb-4 leading-relaxed">
            Database credentials are missing. The application cannot synchronize with the cloud matrix.
          </p>
          <div className="bg-dark-charcoal p-4 rounded-lg text-left mb-4 overflow-x-auto">
             <code className="text-xs font-mono text-electric-blue block mb-2">SUPABASE_URL=...</code>
             <code className="text-xs font-mono text-electric-blue block">SUPABASE_ANON_KEY=...</code>
          </div>
          <p className="text-xs text-text-dark uppercase tracking-widest">Please configure your environment variables.</p>
        </div>
      </div>
    );
  }

  // Password reset page has highest priority
  if (resetToken) {
    // Show password reset page - don't sign out as the access token will set the session
    return <PasswordReset accessToken={resetToken} onClose={() => setResetToken(null)} />;
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
            SYNCING NEURAL LINK...
        </div>
    );
  }

  if (dataError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-dark-charcoal p-4 text-center">
            <span className="material-symbols-outlined text-5xl text-red-500 mb-4">signal_wifi_off</span>
            <p className="text-white font-headline text-2xl mb-4">{dataError}</p>
            <button 
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-mid-charcoal text-electric-blue rounded-lg hover:bg-electric-blue hover:text-charcoal transition-colors"
            >
                RETRY CONNECTION
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
          <p className="font-medium">{notification.message}</p>
        </div>
      )}

      {/* ⚠️ Conflict Resolution Modal */}
      {conflictModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="bg-light-charcoal border-2 border-yellow-500 rounded-3xl p-8 max-w-2xl w-full shadow-[0_0_50px_rgba(234,179,8,0.3)] scale-in-center">
            <div className="flex items-center gap-3 mb-6">
              <span className="material-symbols-outlined text-5xl text-yellow-500">warning</span>
              <h3 className="text-3xl font-headline text-white tracking-tight">SYNC CONFLICT</h3>
            </div>

            <p className="text-text-light mb-8 text-sm leading-relaxed">
              检测到云端和本地有不同版本的该 Session。请选择要保留的版本：
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
                  <h4 className="text-lg font-headline text-white">云端版本</h4>
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-text-light">
                    <span className="text-text-dark">时间：</span>
                    {new Date(conflictModal.cloud.timestamp).toLocaleString()}
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">单词数：</span>
                    {conflictModal.cloud.wordCount} 个
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">标签：</span>
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
                  <h4 className="text-lg font-headline text-white">本地版本</h4>
                </div>
                <div className="space-y-2 text-sm">
                  <p className="text-text-light">
                    <span className="text-text-dark">时间：</span>
                    {new Date(conflictModal.local.timestamp).toLocaleString()}
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">单词数：</span>
                    {conflictModal.local.wordCount} 个
                  </p>
                  <p className="text-text-light">
                    <span className="text-text-dark">标签：</span>
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
                取消
              </button>
              <button
                onClick={handleConfirmConflictResolution}
                disabled={!conflictChoice}
                className="flex-1 py-4 rounded-xl bg-electric-green text-charcoal hover:bg-white transition-all font-headline text-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined">check_circle</span>
                使用 {conflictChoice === 'cloud' ? '云端' : '本地'} 版本
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
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => { setMode('DASHBOARD'); setEditingSessionId(null); setTestConfig(null); }}>
          <span className="material-symbols-outlined text-electric-green text-3xl">bolt</span>
          <h1 className="font-headline text-2xl tracking-tighter text-electric-blue">VOCAB MONSTER</h1>
        </div>
        <div className="flex items-center gap-4">
          <div 
            className="hidden sm:flex items-center gap-2 text-xs font-mono text-text-dark cursor-pointer hover:text-white transition-colors group"
            onClick={() => setShowAccountPanel(true)}
          >
            <span className="material-symbols-outlined text-sm group-hover:text-electric-blue transition-colors">cloud_done</span>
            <span className="group-hover:underline underline-offset-4">{session.user.email}</span>
          </div>
          <button onClick={handleLogout} className="p-2 text-text-light hover:text-red-400 transition-colors" title="Logout">
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
            onDeleteSessions={(ids) => {
                setIdsToDelete(ids);
                setShowDeleteConfirm(true);
            }}
            onManualSync={handleManualSync}
            syncingSessionId={syncingSessionId}
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
          />
        )}
        {mode === 'TEST' && (
          <TestModeV2 
            allWords={visibleWords}
            sessions={sessions}
            initialSessionIds={testConfig?.sessionIds || []}
            initialWordIds={testConfig?.wordIds}
            onUpdateWord={(id, updates) => {
                setWords(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
            }}
            onComplete={async (results: { id: string; correct: boolean; score: number }[]) => {
              // ✨ Now waits for database sync to complete before navigating
              await updateLocalStats(results);
              setMode('DASHBOARD');
            }}
            onCancel={() => setMode('DASHBOARD')}
          />
        )}
        {mode === 'LIBRARY' && (
            <LibraryMode 
                words={visibleWords}
                onClose={() => setMode('DASHBOARD')}
                onTest={handleStartTestFromLibrary}
                userId={session?.user?.id}
                onRefresh={refreshData}
            />
        )}

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
                <div className="bg-light-charcoal border border-red-500/50 rounded-3xl p-8 max-w-md w-full shadow-[0_0_30px_rgba(239,68,68,0.2)] scale-in-center">
                    <div className="flex items-center gap-3 mb-4 text-red-500">
                        <span className="material-symbols-outlined text-4xl">{isDeleting ? 'delete_sweep' : 'warning'}</span>
                        <h3 className="text-2xl font-headline tracking-tight">
                            {isDeleting ? 'DELETING...' : 'CONFIRM DELETION'}
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
                                    Preparing...
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'deleting-words' ? 'text-electric-blue' : deleteProgress?.step && ['deleting-sessions', 'cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'deleting-words' ? 'pending' : deleteProgress?.step && ['deleting-sessions', 'cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    Deleting words...
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'deleting-sessions' ? 'text-electric-blue' : deleteProgress?.step && ['cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'deleting-sessions' ? 'pending' : deleteProgress?.step && ['cleaning-tags', 'complete'].includes(deleteProgress.step) ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    Deleting sessions...
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-mono ${deleteProgress?.step === 'cleaning-tags' ? 'text-electric-blue' : deleteProgress?.step === 'complete' ? 'text-electric-green' : 'text-text-dark'}`}>
                                    <span className="material-symbols-outlined text-sm">
                                        {deleteProgress?.step === 'cleaning-tags' ? 'pending' : deleteProgress?.step === 'complete' ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    Cleaning up tags...
                                </div>
                            </div>
                        </div>
                    ) : (
                        // Confirmation View
                        <>
                            <p className="text-white font-body mb-2">
                                You are about to delete <span className="text-electric-blue font-bold">{idsToDelete.length}</span> session(s).
                            </p>
                            <p className="text-text-dark font-mono text-xs mb-8 p-4 bg-dark-charcoal rounded-xl border border-mid-charcoal">
                                WARNING: This action will permanently remove all associated words from your library and the cloud database. This process is irreversible.
                            </p>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <button 
                                    onClick={() => {
                                        setShowDeleteConfirm(false);
                                        setIdsToDelete([]);
                                    }}
                                    className="bg-mid-charcoal hover:bg-white hover:text-charcoal text-text-light transition-all p-4 rounded-xl font-headline tracking-wider text-sm"
                                >
                                    CANCEL
                                </button>
                                <button 
                                    onClick={handleExecuteDelete}
                                    className="bg-red-500 hover:bg-red-600 text-white transition-all p-4 rounded-xl font-headline tracking-wider text-sm shadow-lg shadow-red-900/20"
                                >
                                    DELETE FOREVER
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
                    <h3 className="text-3xl font-headline text-white mb-2 tracking-tight">CHOOSE TEST RANGE</h3>
                    <p className="text-text-dark font-body mb-8">Select which words you want to practice right now.</p>
                    
                    <div className="grid gap-4">
                        <button 
                            onClick={() => {
                                if (selectedDashboardSessionIds.size > 0) {
                                    handleStartTest(Array.from(selectedDashboardSessionIds));
                                    setShowQuickTestModal(false);
                                } else {
                                    alert("Please select at least one session card from the dashboard first!");
                                }
                            }}
                            className={`transition-all p-6 rounded-2xl flex flex-col items-start gap-1 group text-left ${
                                selectedDashboardSessionIds.size > 0 
                                ? 'bg-mid-charcoal hover:bg-electric-blue hover:text-charcoal' 
                                : 'bg-mid-charcoal/50 opacity-100 border border-dashed border-mid-charcoal'
                            }`}
                        >
                            <span className={`text-sm font-mono uppercase tracking-widest ${
                                selectedDashboardSessionIds.size > 0 ? 'text-electric-blue group-hover:text-charcoal' : 'text-text-dark'
                            }`}>
                                Option 1
                            </span>
                            <span className={`text-xl font-headline ${
                                selectedDashboardSessionIds.size > 0 ? 'group-hover:text-charcoal' : 'text-text-dark'
                            }`}>
                                {selectedDashboardSessionIds.size > 0 ? 'TEST SELECTED (' + selectedDashboardSessionIds.size + ')' : 'RECENT SESSION'}
                            </span>
                            <span className={`text-xs font-body ${
                                selectedDashboardSessionIds.size > 0 ? 'opacity-50 group-hover:text-charcoal/70' : 'text-text-dark/40'
                            }`}>
                                {selectedDashboardSessionIds.size > 0 
                                    ? `Practice words from your current selection.` 
                                    : `Select one or more cards on the dashboard to test.`
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
                            <span className="text-sm font-mono text-electric-green group-hover:text-charcoal uppercase tracking-widest">Option 2</span>
                            <span className="text-xl font-headline group-hover:text-charcoal">ALL WORD LIBRARY</span>
                            <span className="text-xs opacity-50 font-body group-hover:text-charcoal/70">A comprehensive test of all {visibleWords.length} words in your vault.</span>
                        </button>

                        <button 
                            onClick={() => setShowQuickTestModal(false)}
                            className="mt-4 text-text-dark hover:text-white transition-colors uppercase font-mono text-xs tracking-[0.2em]"
                        >
                            Maybe Later
                        </button>
                    </div>
                </div>
            </div>
        )}
        
        {/* Achievement Unlock Modal */}
        {achievementQueue.length > 0 && (
            <AchievementUnlockModal 
                achievement={achievementQueue[0]} 
                onClose={() => setAchievementQueue(prev => prev.slice(1))} 
            />
        )}
      </main>

      <footer className="py-2 text-center text-text-dark text-[10px] border-t border-mid-charcoal bg-dark-charcoal/80 backdrop-blur-md fixed bottom-0 left-0 right-0 z-50">
        <p>&copy; 2024 VOCAB MONSTER - CLOUD SYNCED</p>
      </footer>

      {showAccountPanel && session && (
        <AccountPanel 
          user={session.user}
          words={visibleWords}
          sessions={visibleSessions}
          onClose={() => setShowAccountPanel(false)}
          onLogout={() => {
              handleLogout();
              setShowAccountPanel(false);
          }}
        />
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
    </div>
  );
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
  const MAX_SLOTS = 12; // 2 rows x 6 cols
  const count = sessions.length;
  const showMoreButton = count > MAX_SLOTS;
  
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
    <div className={`grid gap-4 w-full h-full transition-all duration-700 ${gridClass}`}>
      {visibleSessions.map(s => (
        <div 
          key={s.id} 
          className={`bg-light-charcoal rounded-xl border group transition-all flex flex-col overflow-hidden relative shadow-lg ${selectedIds.has(s.id) ? 'border-electric-green ring-1 ring-electric-green' : 'border-mid-charcoal hover:border-electric-blue'}`}
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
                  {new Date(s.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' })}
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
              <div className="cursor-pointer" onClick={() => onEdit(s.id)} title="Click to Edit Words">
                <p className={`font-headline text-white group-hover:text-electric-blue leading-none transition-colors ${isHighDensity ? 'text-xl' : 'text-5xl'}`}>
                  {s.wordCount} <span className={`text-text-dark font-body font-normal ${isHighDensity ? 'text-[10px]' : 'text-sm'}`}>WORDS</span>
                </p>
                <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                   <span className="material-symbols-outlined text-[10px] text-electric-blue">edit</span>
                   <span className="text-[10px] text-electric-blue uppercase">Edit</span>
                </div>
              </div>
              
              <button
                onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s.id);
                }}
                className={`bg-mid-charcoal rounded-lg text-text-dark hover:bg-red-500 hover:text-white transition-colors flex items-center justify-center z-20 ${isHighDensity ? 'p-1.5' : 'p-3'}`}
                title="Delete Session"
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
                  title={syncingSessionId === s.id ? '正在同步...' : '点击同步到云端'}
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
            <span className="font-headline text-xl text-text-dark group-hover:text-white">{count - visibleCount} MORE</span>
        </button>
      )}
    </div>
  );
};

// --- Dashboard Component ---
const Dashboard: React.FC<{
  stats: Record<string, DayStats>,
  sessions: InputSession[],
  words: WordEntry[],
  selectedSessionIds: Set<string>,
  onToggleSessionSelect: (id: string) => void,
  onStartInput: () => void,
  onStartTest: (sIds: string[]) => void,
  onStartEdit: (sId: string) => void,
  onOpenLibrary: () => void,
  onQuickTest: () => void,
  onDeleteSessions: (ids: string[]) => void,
  onManualSync?: (id: string) => void,
  syncingSessionId?: string | null
}> = ({ stats, sessions, words, selectedSessionIds, onToggleSessionSelect, onStartInput, onStartTest, onStartEdit, onOpenLibrary, onQuickTest, onDeleteSessions, onManualSync, syncingSessionId }) => {
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [showAllSessions, setShowAllSessions] = useState(false);

  // Filter words that already have images for the carousel
  const wordsWithImages = useMemo(() => words.filter(w => w.image_url), [words]);

  // 1. Auto-rotation logic (5 seconds)
  useEffect(() => {
    // Only start carousel if we have at least 10 images, as requested
    if (wordsWithImages.length < 10) return;

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

  const totalCorrect = Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.correct, 0);
  const totalAll = Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.total, 0);
  const accuracy = (totalAll as number) > 0 ? ((totalCorrect as number) / (totalAll as number)) * 100 : 0;

  return (
    <div className="grid lg:grid-cols-12 gap-8 items-stretch animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="lg:col-span-8 flex flex-col gap-10">
        <div className="flex flex-col md:flex-row items-center gap-10">
          
          <div className="w-full md:w-80 h-80 flex-shrink-0 relative group order-last md:order-first">
            <div className="absolute -inset-1 bg-gradient-to-r from-electric-blue to-electric-purple rounded-3xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative w-full h-full bg-light-charcoal rounded-3xl border border-mid-charcoal overflow-hidden flex flex-col items-center justify-center">
              {wordsWithImages.length >= 10 ? (
                <div key={wordsWithImages[carouselIndex].id} className="w-full h-full relative animate-in fade-in duration-1000">
                  <img 
                    src={wordsWithImages[carouselIndex].image_url!} 
                    alt={wordsWithImages[carouselIndex].text} 
                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" 
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark-charcoal via-transparent to-transparent opacity-80 shadow-[inset_0_-40px_60px_rgba(0,0,0,0.5)]"></div>
                  <div className="absolute bottom-4 left-4 right-4 z-10 animate-in slide-in-from-bottom-2 fade-in duration-700 delay-150">
                    <p className="text-[10px] font-mono text-electric-blue uppercase tracking-[0.2em] mb-1 drop-shadow-sm">Featured</p>
                    <p className="font-serif text-2xl text-white italic capitalize drop-shadow-lg">{wordsWithImages[carouselIndex].text}</p>
                    <div className="flex gap-1 mt-3">
                        {wordsWithImages.map((_, idx) => (
                            <div key={idx} className={`h-1 rounded-full transition-all duration-500 ${idx === carouselIndex ? 'w-4 bg-electric-blue' : 'w-1 bg-white/20'}`} />
                        ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="w-full h-full relative animate-in fade-in duration-700">
                  <img src="/publicImages/ALL.webp" alt="Welcome" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
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
            <p className="text-xl text-text-dark max-w-xl md:ml-auto relative z-10">Master vocabulary with challenges and AI.</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-6">
          <button 
            onClick={onStartInput}
            className="flex-1 bg-mid-charcoal border-2 border-electric-green text-electric-green font-headline text-3xl py-8 px-10 rounded-2xl hover:bg-electric-green hover:text-charcoal transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-4"
          >
            <span className="material-symbols-outlined text-4xl">add_circle</span>
            ADD WORDS
          </button>
          
          {selectedSessionIds.size > 0 ? (
             <button 
                onClick={() => onStartTest(Array.from(selectedSessionIds))}
                className="flex-1 bg-electric-blue text-charcoal font-headline text-3xl py-8 px-10 rounded-2xl hover:bg-white transition-all transform hover:-translate-y-1 hover:shadow-[0_0_20px_rgba(0,240,255,0.4)] flex items-center justify-center gap-4 animate-in fade-in"
             >
                <span className="material-symbols-outlined text-4xl">checklist</span>
                TEST SELECTED ({selectedSessionIds.size})
             </button>
          ) : (
             <button 
                className="flex-1 bg-electric-green text-charcoal font-headline text-3xl py-8 px-10 rounded-2xl hover:bg-electric-blue transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-4"
                onClick={() => (sessions && sessions.length > 0) ? onQuickTest() : onStartInput()}
             >
                <span className="material-symbols-outlined text-4xl">play_arrow</span>
                QUICK TEST
             </button>
          )}
        </div>

        {/* Adaptive Session Matrix Section */}
        <div className="space-y-4">
          <div className="flex justify-between items-end border-b border-mid-charcoal pb-2">
            <h3 className="font-headline text-2xl text-text-light tracking-widest">RECENT SESSIONS</h3>
            <div className="flex items-center gap-4">
                {showAllSessions && selectedSessionIds.size > 0 && (
                    <button 
                        onClick={() => onDeleteSessions(Array.from(selectedSessionIds))}
                        className="text-xs font-mono text-red-500 hover:text-red-400 uppercase flex items-center gap-1 transition-colors"
                    >
                        <span className="material-symbols-outlined text-sm">delete</span>
                        DELETE ({selectedSessionIds.size})
                    </button>
                )}
                {showAllSessions ? (
                    <button onClick={() => setShowAllSessions(false)} className="text-xs font-mono text-electric-blue hover:text-white uppercase">
                        Back to Matrix
                    </button>
                ) : (
                    sessions.length > 0 && <span className="text-xs font-mono text-text-dark opacity-50">{sessions.length} TOTAL</span>
                )}
            </div>
          </div>
          
          <div className="bg-dark-charcoal/50 p-1 rounded-2xl border border-mid-charcoal/30">
            {sessions.length === 0 ? (
                <div className="p-12 border-2 border-dashed border-mid-charcoal rounded-xl text-center text-text-dark h-96 flex flex-col items-center justify-center">
                    <span className="material-symbols-outlined text-6xl opacity-20 mb-4">layers_clear</span>
                    <p>No sessions yet. Start by adding some words!</p>
                </div>
            ) : showAllSessions ? (
                /* Full List View */
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 h-96 overflow-y-auto p-4 custom-scrollbar">
                    {sessions.map(s => (
                        <div key={s.id} className={`bg-light-charcoal p-4 rounded-xl border flex justify-between items-center group transition-all ${selectedSessionIds.has(s.id) ? 'border-electric-green' : 'border-mid-charcoal hover:border-text-light'}`}>
                             <div className="flex items-center gap-3">
                                <input 
                                    type="checkbox" 
                                    checked={selectedSessionIds.has(s.id)}
                                    onChange={() => onToggleSessionSelect(s.id)}
                                    className="w-4 h-4 rounded border-mid-charcoal text-electric-green bg-dark-charcoal cursor-pointer"
                                />
                                <div onClick={() => onStartEdit(s.id)} className="cursor-pointer">
                                    <p className="text-xs font-mono text-text-dark mb-1">{new Date(s.timestamp).toLocaleDateString()}</p>
                                    <p className="font-headline text-2xl text-white group-hover:text-electric-blue">{s.wordCount} WORDS</p>
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
                                  title={syncingSessionId === s.id ? '正在同步...' : '点击同步到云端'}
                                >
                                  <span className={`material-symbols-outlined text-lg ${syncingSessionId === s.id ? 'animate-spin' : ''}`}>
                                    {syncingSessionId === s.id ? 'refresh' : (
                                      s.syncStatus === 'synced' ? 'check_box' :
                                      s.syncStatus === 'pending' ? 'check_box_outline_blank' :
                                      'error'
                                    )}
                                  </span>
                                </button>

                                <button onClick={() => onStartEdit(s.id)} className="p-2 bg-mid-charcoal rounded-lg text-text-light hover:text-electric-blue transition-colors" title="Edit">
                                    <span className="material-symbols-outlined text-lg">edit</span>
                                </button>
                                <button onClick={() => onDeleteSessions([s.id])} className="p-2 bg-mid-charcoal rounded-lg text-text-dark hover:bg-red-500 hover:text-white transition-colors" title="Delete">
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
      </div>

      <div className="lg:col-span-4 flex flex-col gap-4">
        <CalendarView stats={stats} />
        
        <AchievementsPanel words={words} sessions={sessions} className="flex-1" />

        {/* Word Library Card */}
        <div 
            onClick={onOpenLibrary}
            className="flex-1 bg-light-charcoal py-4 px-6 rounded-2xl border border-mid-charcoal group hover:border-electric-blue cursor-pointer transition-all relative overflow-hidden flex flex-col justify-center min-h-[130px]"
        >
            <h3 className="font-headline text-xl text-text-light mb-0.5 tracking-widest uppercase group-hover:text-electric-blue transition-colors">Word Library</h3>
            <p className="text-text-dark text-[10px] mb-3 relative z-10 opacity-70">Browse and manage your full collection alphabetically.</p>
            
            <div className="flex items-center justify-between relative z-10 pr-1">
                <div className="flex items-center gap-3">
                    <div className="bg-dark-charcoal p-1.5 rounded-lg border border-mid-charcoal group-hover:border-electric-blue/50 transition-colors">
                        <span className="font-mono text-electric-blue font-bold text-lg">{words.length}</span>
                    </div>
                    <span className="font-mono text-[9px] text-text-dark uppercase tracking-tighter">Total Entries</span>
                </div>
                <div className="bg-electric-blue/20 p-1 rounded-full text-electric-blue group-hover:bg-electric-blue group-hover:text-charcoal transition-all">
                    <span className="material-symbols-outlined text-xl">arrow_forward</span>
                </div>
            </div>
        </div>
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
}> = ({ words, onClose, onTest, userId, onRefresh }) => {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    
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
        const result = sortedWords.filter((w: WordEntry) => w.text.toLowerCase().includes(searchTerm.toLowerCase()));
        console.log('[LibraryMode] Filter stats:', {
            totalWords: words.length,
            libraryFiltered: libraryFilteredWords.length,
            sortedWords: sortedWords.length,
            searchTerm: searchTerm || '(empty)',
            filteredWords: result.length
        });
        return result;
    }, [sortedWords, searchTerm, words.length, libraryFilteredWords.length]);

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

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 animate-in fade-in slide-in-from-bottom-4 duration-500 min-h-[calc(100vh-100px)] flex flex-col md:flex-row gap-6">
            
            {/* Sidebar Tools */}
            <div className="w-full md:w-80 flex flex-col gap-6 flex-shrink-0">
                <div className="flex items-center gap-4 mb-2">
                     <button onClick={onClose} className="p-3 bg-mid-charcoal hover:bg-text-light hover:text-charcoal rounded-full transition-colors border border-mid-charcoal">
                        <span className="material-symbols-outlined">arrow_back</span>
                     </button>
                     <div>
                        <h2 className="font-headline text-3xl text-white tracking-wide">LIBRARY</h2>
                        <p className="font-mono text-[10px] text-text-dark uppercase">{new Set(words.map((w: WordEntry) => w.text)).size} UNIQUE WORDS ({selectedLibraries.has('All') ? 'SHOWING ALL' : `FILTERED: ${libraryFilteredWords.length}`})</p>
                     </div>
                </div>

                <div className="bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg">
                    <h3 className="font-headline text-xl text-electric-blue mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined">casino</span>
                        RANDOMIZER
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
                            PICK RANDOM
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

                <div className="bg-light-charcoal p-5 rounded-2xl border border-mid-charcoal shadow-lg flex-1 flex flex-col">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-headline text-xl text-electric-blue flex items-center gap-2">
                            <span className="material-symbols-outlined">grid_view</span>
                            A-Z MATRIX
                        </h3>
                        <span className="text-[10px] text-text-dark uppercase">Drag to select</span>
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
                                        setIsMouseDown(true);
                                        if (hasWords) toggleLetterGroup(letter);
                                    }}
                                    onMouseEnter={() => {
                                        if (isMouseDown && hasWords) {
                                            // Determine intent based on current state of this letter: usually inverted of current?
                                            // Simple drag logic: toggle it
                                            toggleLetterGroup(letter);
                                        }
                                    }}
                                    onMouseUp={() => setIsMouseDown(false)}
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
                            placeholder="Search library..."
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
                                    Reset
                                </button>
                                <button 
                                    onClick={() => onTest(Array.from(selectedIds))}
                                    className="px-6 py-2 bg-electric-blue text-charcoal font-headline text-xl rounded-xl hover:bg-white transition-colors flex items-center gap-2 shadow-[0_0_15px_rgba(0,240,255,0.3)] animate-in zoom-in"
                                >
                                    <span className="material-symbols-outlined">checklist</span>
                                    TEST ({selectedIds.size})
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
                            <p className="font-headline text-xl">No words found</p>
                        </div>
                    ) : (
                        Object.keys(grouped).sort().map(letter => {
                            if (grouped[letter].length === 0) return null;
                            return (
                                <div key={letter} className="mb-8">
                                    <div className="flex items-center gap-4 mb-4 border-b border-mid-charcoal/50 pb-2">
                                        <h3 className="font-headline text-3xl text-electric-blue w-8">{letter}</h3>
                                        <span className="text-[10px] font-mono text-text-dark opacity-50 ml-auto">{grouped[letter].length} items</span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                        {grouped[letter].map(word => (
                                            <div 
                                                key={word.id} 
                                                onClick={() => toggleSelection(word.id)}
                                                className={`px-4 py-3 rounded-lg border cursor-pointer transition-all flex items-center justify-between group relative overflow-hidden ${
                                                    selectedIds.has(word.id) 
                                                    ? 'bg-electric-blue/10 border-electric-blue shadow-[inset_0_0_10px_rgba(0,240,255,0.1)]' 
                                                    : 'bg-light-charcoal border-mid-charcoal hover:border-text-light'
                                                }`}
                                            >
                                                <div className="flex items-center gap-3 overflow-hidden">
                                                    <div className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors flex-shrink-0 ${selectedIds.has(word.id) ? 'bg-electric-blue border-electric-blue' : 'border-text-dark bg-transparent'}`}>
                                                        {selectedIds.has(word.id) && <span className="material-symbols-outlined text-charcoal text-[10px] font-bold">check</span>}
                                                    </div>
                                                    <span className={`font-mono truncate ${selectedIds.has(word.id) ? 'text-white' : 'text-text-light'}`}>{word.text}</span>
                                                </div>
                                                {word.correct && <span className="material-symbols-outlined text-electric-green text-sm opacity-50 group-hover:opacity-100" title="Mastered">check_circle</span>}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};

// --- Input Mode Component ---
const InputMode: React.FC<{ 
  initialWords?: WordEntry[],
  currentLibrary: string, // The library tag of the session being edited (or 'Custom' for new sessions)
  onComplete: (words: { id?: string, text: string, imageBase64?: string }[], deletedIds: string[]) => void,
  onCancel: () => void,
  onDeleteWord?: (id: string) => Promise<void>,
  allWords: WordEntry[]
}> = ({ initialWords = [], currentLibrary, onComplete, onCancel, onDeleteWord, allWords }) => {
  const [currentWords, setCurrentWords] = useState<{ id?: string, text: string, imageBase64?: string }[]>(
    initialWords.map(w => ({ id: w.id, text: w.text }))
  );
  // We don't use deletedIds for batch delete anymore based on new requirements, 
  // but keeping it empty for compatibility with onComplete refactoring if needed.
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [serviceErrorWord, setServiceErrorWord] = useState<string | null>(null);

  // Phrase validation states
  const [collocationWarning, setCollocationWarning] = useState<{
    phrase: string;
    suggestion?: string;
  } | null>(null);
  const [pendingPhrase, setPendingPhrase] = useState<string | null>(null);
  
  // Feature 1: Drill Logic
  const [targetWord, setTargetWord] = useState<string | null>(null);
  const [repeatCount, setRepeatCount] = useState<number>(3);
  const [drillProgress, setDrillProgress] = useState<number>(0);
  const [inputStatus, setInputStatus] = useState<'idle' | 'correct' | 'wrong'>('idle');

  // Feature 2: Audio
  const [playingAudio, setPlayingAudio] = useState<string | null>(null);

  // Bug Fix: Delete Confirmation
  const [wordToDelete, setWordToDelete] = useState<{ index: number, item: any } | null>(null);
  
  // Bug Fix: Unsaved Changes Warning
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track if there are unsaved changes
  const hasUnsavedChanges = () => {
    // New words added (comparing length with initial words)
    const newWordsCount = currentWords.filter(w => !w.id).length;
    // Words deleted from initial set (via deletedIds or onDeleteWord immediate sync)
    const deletedCount = initialWords.length - currentWords.filter(w => w.id).length;
    return newWordsCount > 0 || deletedCount > 0;
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
    setErrorMsg(null);
    setServiceErrorWord(null);
    setInputStatus('idle');
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // --- PHASE 1: New Word Validation ---
    if (!targetWord) {
      // Local Check: Check within current session's word list
      if (currentWords.some(w => w.text.toLowerCase() === trimmed.toLowerCase())) {
          setErrorMsg(`"${trimmed}" is already in this session.`);
          playBuzzer();
          return;
      }
      
      // Global Check: Check if word exists anywhere in the user's collection
      const existingWord = allWords.find(w => w.text.toLowerCase() === trimmed.toLowerCase());
      if (existingWord) {
          const tags = existingWord.tags?.join(', ') || 'Custom';
          setErrorMsg(`"${trimmed}" already exists in your collection (${tags}).`);
          playBuzzer();
          return;
      }

      setIsProcessing(true);

      // Check if input is a phrase (contains spaces)
      const isPhrase = trimmed.includes(' ');

      let validation;
      if (isPhrase) {
        // Use phrase validation for multi-word inputs
        validation = await aiService.validatePhrase(trimmed);
      } else {
        // Use single word validation
        validation = await aiService.validateSpelling(trimmed);
      }
      setIsProcessing(false);

      if (validation.serviceError) {
        setServiceErrorWord(trimmed);
        playBuzzer();
        return;
      }

      // Handle phrase length errors
      if (validation.error === 'TOO_MANY_WORDS' || validation.error === 'TOO_FEW_WORDS') {
        playBuzzer();
        setErrorMsg(validation.suggestion || 'Please enter 2-3 words only');
        return;
      }

      if (!validation.isValid) {
        playBuzzer();
        // Show highlighted phrase if available
        const displayText = validation.highlightedPhrase || validation.suggestion || 'something else';
        setErrorMsg(`Did you mean "${displayText}"?`);
        return;
      }

      // Handle 2-word phrase collocation check
      if (validation.needsCollocationCheck) {
        setIsProcessing(true);
        try {
          const collocationResult = await aiService.validateCollocation(trimmed);
          setIsProcessing(false);

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
          setIsProcessing(false);
          // On error, continue with the phrase
        }
      }

      // Start Drill
      setTargetWord(trimmed);
      setDrillProgress(1); // First input counts as 1
      setInputValue('');
      setInputStatus('correct');
      playDing();
      playWordAudio(trimmed);
      
      // If repeat count is 1, we are done immediately
      if (repeatCount === 1) {
          finishAddingWord(trimmed);
      }
      return;
    }

    // --- PHASE 2: Drill Repetition ---
    if (targetWord) {
        if (trimmed.toLowerCase() === targetWord.toLowerCase()) {
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
            setErrorMsg(`Type "${targetWord}" again!`);
        }
    }
  };

  const finishAddingWord = (text: string) => {
      const newEntry = { text: text, imageBase64: undefined };
      setCurrentWords(prev => [...prev, newEntry]);
      setTargetWord(null);
      setDrillProgress(0);
      setInputValue('');
      setTimeout(() => setInputStatus('idle'), 1000);
      playDing(); // Double ding for completion?
  };

  const handleManualAdd = () => {
    if (serviceErrorWord) {
       // Start drill with unvalidated word
       setTargetWord(serviceErrorWord);
       setDrillProgress(1);
       setInputValue('');
       setServiceErrorWord(null);
       playDing();
       if (repeatCount === 1) finishAddingWord(serviceErrorWord);
    } else if (collocationWarning && pendingPhrase) {
       // Force add phrase despite collocation warning
       setTargetWord(pendingPhrase);
       setDrillProgress(1);
       setInputValue('');
       setCollocationWarning(null);
       setPendingPhrase(null);
       playDing();
       if (repeatCount === 1) finishAddingWord(pendingPhrase);
    }
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
          alert("Failed to delete word: " + (error as Error).message);
          // 即使失败也关闭模态框，让用户可以重试
          setWordToDelete(null);
      }
  };

  const handleSubmitSession = async () => {
    setIsSaving(true);
    // deletedIds should be empty if we exclusively use immediate delete, but passing it just in case
    await onComplete(currentWords, deletedIds);
  };

  const handleVoiceInput = () => {
    setErrorMsg(null);
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.onstart = () => setIsProcessing(true);
    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      setInputValue(text);
      setIsProcessing(false);
      // Auto-submit if needed? No, let user confirm.
    };
    recognition.onerror = () => setIsProcessing(false);
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
        alert("Could not extract word from image.");
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
            <h2 className="font-headline text-2xl text-white">Saving Neural Link...</h2>
        </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-12 py-10 animate-in fade-in duration-500 relative">
      <div className="w-full flex items-center justify-between px-2">
         <button 
            onClick={handleCancelClick} 
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-light-charcoal border border-mid-charcoal text-text-light hover:text-white hover:border-electric-blue transition-all group"
         >
            <span className="material-symbols-outlined group-hover:-translate-x-1 transition-transform">arrow_back</span>
            <span className="font-mono text-xs uppercase tracking-wider">Dashboard</span>
         </button>
         
         {/* Repetition Setting */}
         <div className="flex items-center gap-3 bg-light-charcoal border border-mid-charcoal px-4 py-2 rounded-full">
            <span className="text-[10px] font-mono uppercase text-text-dark">Repetitions</span>
            <div className="flex items-center gap-2">
                <button 
                    onClick={() => setRepeatCount(Math.max(1, repeatCount - 1))}
                    className="w-6 h-6 rounded-full bg-dark-charcoal flex items-center justify-center hover:bg-mid-charcoal text-white"
                >
                    -
                </button>
                <span className="font-mono text-electric-blue font-bold w-4 text-center">{repeatCount}</span>
                <button 
                    onClick={() => setRepeatCount(Math.min(10, repeatCount + 1))}
                    className="w-6 h-6 rounded-full bg-dark-charcoal flex items-center justify-center hover:bg-mid-charcoal text-white"
                >
                    +
                </button>
            </div>
         </div>
         
         {initialWords.length > 0 && (
             <span className="font-mono text-xs text-electric-blue border border-electric-blue/30 px-3 py-1 rounded-full uppercase tracking-wider">Editing Mode</span>
         )}
      </div>

      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-4 bg-light-charcoal p-4 rounded-2xl border border-mid-charcoal shadow-lg">
          <span className="material-symbols-outlined text-electric-blue">checklist</span>
          <label className="text-sm font-headline text-text-dark tracking-widest uppercase">Session Words:</label>
          <span className="font-mono font-bold text-2xl text-electric-green">{currentWords.length}</span>
        </div>
      </div>

      <div className="relative flex flex-col items-center">
        {/* Drill Indicators */}
        <div className="flex gap-4 mb-4 h-8 items-end">
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
          placeholder={targetWord ? `TYPE "${targetWord}"` : "TYPE WORD..."}
          disabled={isProcessing}
          status={inputStatus}
          hintOverlay={targetWord ? undefined : undefined} 
        />
        
        {/* Drill Info Text */}
        {targetWord && (
            <div className="absolute top-0 right-0 transform translate-x-full pl-4 hidden md:block w-48">
                 <div className="bg-light-charcoal/50 border border-electric-blue/30 p-4 rounded-2xl backdrop-blur-md">
                     <p className="font-mono text-[10px] uppercase text-text-dark mb-1">Target</p>
                     <p className="font-serif text-xl text-white truncate">{targetWord}</p>
                     <p className="text-[10px] text-electric-blue mt-2">Type correctly {repeatCount} times to add.</p>
                 </div>
            </div>
        )}

        {isProcessing && (
          <div className="absolute inset-0 bg-charcoal/50 backdrop-blur-sm flex items-center justify-center rounded-xl z-10 h-64 md:h-80">
             <div className="flex items-center gap-3 text-electric-blue font-headline text-2xl animate-pulse">
                <span className="material-symbols-outlined animate-spin">sync</span>
                VALIDATING...
             </div>
          </div>
        )}
        
        {errorMsg && (
          <div className="absolute top-full text-center mt-4 flex justify-center animate-in slide-in-from-top-2 z-50">
            <div className="bg-red-600 border border-red-400 text-white px-6 py-3 rounded-xl flex items-center gap-3 shadow-[0_0_25px_rgba(220,38,38,0.4)]">
               <span className="material-symbols-outlined">report</span>
               <span className="font-mono font-bold tracking-tight">{errorMsg}</span>
            </div>
          </div>
        )}

        {serviceErrorWord && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 flex justify-center animate-in slide-in-from-top-2 z-50 w-full max-w-md">
            <div className="bg-light-charcoal border-2 border-electric-purple text-white px-8 py-6 rounded-2xl flex flex-col items-center gap-4 shadow-[0_0_40px_rgba(147,51,234,0.3)] w-full text-center">
               <div className="flex items-center gap-3 text-electric-purple mb-1">
                  <span className="material-symbols-outlined text-3xl">cloud_off</span>
                  <span className="font-headline text-xl uppercase tracking-widest">Neural Link Offline</span>
               </div>
               <p className="font-mono text-sm text-text-light leading-relaxed">
                  The AI validation service could not be reached. We cannot verify if <span className="text-electric-blue">"{serviceErrorWord}"</span> is correct.
               </p>
               <div className="flex gap-4 w-full">
                  <button 
                    onClick={() => setServiceErrorWord(null)}
                    className="flex-1 py-3 px-4 rounded-xl border border-mid-charcoal hover:bg-mid-charcoal transition-all font-mono text-xs uppercase tracking-widest"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleManualAdd}
                    className="flex-1 py-3 px-4 rounded-xl bg-electric-purple text-white hover:bg-purple-500 transition-all font-sans font-bold text-sm shadow-lg shadow-purple-900/20"
                  >
                    Add Anyway
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
                  <span className="font-headline text-xl uppercase tracking-widest">Uncommon Phrase</span>
               </div>
               <p className="font-mono text-sm text-text-light leading-relaxed">
                  <span className="text-electric-blue">"{collocationWarning.phrase}"</span> may not be a common English phrase.
               </p>
               {collocationWarning.suggestion && (
                 <p className="font-mono text-xs text-text-dark">
                    Did you mean: <span className="text-electric-blue">{collocationWarning.suggestion}</span>?
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
                    Cancel
                  </button>
                  <button
                    onClick={handleManualAdd}
                    className="flex-1 py-3 px-4 rounded-xl bg-amber-500 text-white hover:bg-amber-600 transition-all font-sans font-bold text-sm shadow-lg shadow-amber-900/20"
                  >
                    Force Add
                  </button>
               </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-6 mt-8">
        <button 
          onClick={handleVoiceInput}
          title="Voice Input"
          className="p-6 bg-mid-charcoal rounded-full text-white hover:text-electric-blue border-2 border-transparent hover:border-electric-blue transition-all group"
        >
          <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">mic</span>
        </button>
        <button 
          onClick={() => fileInputRef.current?.click()}
          title="Photo OCR"
          className="p-6 bg-mid-charcoal rounded-full text-white hover:text-electric-purple border-2 border-transparent hover:border-electric-purple transition-all group"
        >
          <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">photo_camera</span>
          <input type="file" ref={fileInputRef} onChange={handlePhotoInput} className="hidden" accept="image/*" />
        </button>
        <button 
          onClick={handleInputEnter}
          disabled={!inputValue.trim()}
          className="px-10 py-6 bg-mid-charcoal text-white font-headline text-3xl rounded-full hover:bg-electric-blue hover:text-charcoal transition-all disabled:opacity-50 disabled:hover:bg-mid-charcoal disabled:hover:text-white border-2 border-electric-blue"
        >
          ENTER
        </button>
      </div>

      <div className="min-h-[100px]">
        {currentWords.length === 0 ? (
          <div className="text-center text-text-dark opacity-50 font-mono text-sm py-8 border-2 border-dashed border-mid-charcoal rounded-xl">
             Words will appear here...
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {currentWords.map((w, i) => (
              <div key={i} className="group relative bg-light-charcoal p-3 rounded-xl border border-mid-charcoal text-center flex items-center justify-between hover:border-text-light transition-all">
                <div className="flex items-center gap-2 overflow-hidden flex-1">
                    <button 
                        onClick={() => playWordAudio(w.text)}
                        className={`w-8 h-8 rounded-full flex items-center justify-center hover:bg-electric-blue hover:text-charcoal transition-colors ${playingAudio === w.text ? 'text-electric-green animate-pulse' : 'text-text-dark'}`}
                    >
                        <span className="material-symbols-outlined text-lg">volume_up</span>
                    </button>
                    <span className="font-mono text-electric-blue truncate">{w.text}</span>
                </div>
                <button 
                    onClick={() => initiateDelete(i)}
                    className="ml-2 w-8 h-8 rounded-lg flex items-center justify-center text-text-dark hover:bg-red-500 hover:text-white transition-colors"
                    title="Remove word"
                >
                    <span className="material-symbols-outlined text-sm">close</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      
      <div className="flex flex-col items-center gap-4 pt-4 pb-8">
        <button 
            onClick={handleSubmitSession}
            disabled={currentWords.length === 0 || !!targetWord}
            className={`w-full max-w-md py-6 rounded-2xl font-headline text-3xl transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-3 disabled:opacity-50 disabled:transform-none bg-mid-charcoal text-text-light hover:bg-electric-green hover:text-charcoal border-2 border-transparent hover:border-white`}
        >
            <span className="material-symbols-outlined text-4xl">check_circle</span>
            {targetWord ? "FINISH WORD FIRST" : (initialWords.length > 0 ? "UPDATE SESSION" : "FINISH & SAVE")}
        </button>
      </div>

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
                <h3 className="text-xl font-headline text-white mb-2">REMOVE WORD?</h3>
                <p className="text-text-dark mb-6 text-sm">
                    Are you sure you want to remove <span className="text-electric-blue font-bold">"{wordToDelete.item.text}"</span>?
                    {wordToDelete.item.id && " This will permanently delete it from your library."}
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
                        Cancel
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
                        DELETE
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
                    <h3 className="text-2xl font-headline text-white tracking-tight">UNSAVED CHANGES</h3>
                </div>
                
                <p className="text-text-light mb-2 text-sm leading-relaxed">
                    You have unsaved changes in this session. What would you like to do?
                </p>
                <p className="text-text-dark font-mono text-xs mb-8 p-4 bg-dark-charcoal rounded-xl border border-mid-charcoal">
                    {currentWords.filter(w => !w.id).length > 0 && `${currentWords.filter(w => !w.id).length} new word(s) added. `}
                    {(initialWords.length - currentWords.filter(w => w.id).length) > 0 && `${initialWords.length - currentWords.filter(w => w.id).length} word(s) removed.`}
                </p>
                
                <div className="grid gap-3">
                    <button 
                        onClick={async () => {
                            setShowUnsavedWarning(false);
                            await handleSubmitSession();
                        }}
                        disabled={!!targetWord}
                        className="w-full py-4 rounded-xl bg-electric-green text-charcoal hover:bg-white transition-all font-headline tracking-wider text-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        <span className="material-symbols-outlined">save</span>
                        {targetWord ? "FINISH WORD FIRST" : "SAVE & UPDATE"}
                    </button>
                    <button 
                        onClick={() => {
                            setShowUnsavedWarning(false);
                            onCancel();
                        }}
                        className="w-full py-4 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-all font-headline tracking-wider shadow-lg"
                    >
                        DISCARD CHANGES
                    </button>
                    <button 
                        onClick={() => setShowUnsavedWarning(false)}
                        className="w-full py-3 rounded-xl bg-mid-charcoal text-text-light hover:bg-white hover:text-charcoal transition-colors font-mono text-xs uppercase tracking-widest"
                    >
                        CANCEL (KEEP EDITING)
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
              <p>Preparing neural pathways...</p>
          </div>
      );
  }

  if (isFinished) {
      const correctCount = results.filter(r => r.correct).length;
      const isPerfect = correctCount === queue.length;

      return (
          <div className="flex flex-col items-center justify-center min-h-[60vh] animate-in zoom-in duration-500">
              {isPerfect && <Confetti />}
              <h2 className="font-headline text-6xl text-white mb-4">SESSION COMPLETE</h2>
              <div className="text-9xl font-mono text-electric-blue mb-8 drop-shadow-[0_0_15px_rgba(0,240,255,0.5)]">
                  {Math.round((correctCount / queue.length) * 100)}%
              </div>
              <p className="text-text-dark mb-8 text-xl">
                  {correctCount} correct out of {queue.length}
              </p>
              <button 
                  onClick={() => onComplete(results)}
                  className="px-10 py-4 bg-mid-charcoal hover:bg-electric-green hover:text-charcoal text-white rounded-xl font-headline text-2xl transition-all"
              >
                  RETURN TO DASHBOARD
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
                        alt="Hint"
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
                         <p className="text-red-400 font-mono text-sm uppercase mb-2">Correction</p>
                         <h3 className="text-4xl md:text-5xl font-serif text-white mb-6 tracking-wide">{currentWord.text}</h3>
                         <button 
                            onClick={() => handleNext(false)}
                            className="px-8 py-3 bg-mid-charcoal border border-mid-charcoal hover:border-text-light text-white rounded-xl transition-all"
                         >
                             Got it
                         </button>
                     </div>
                 ) : feedback === 'CORRECT' ? (
                     <div className="text-center animate-in zoom-in duration-300">
                         <span className="material-symbols-outlined text-8xl text-electric-green mb-2">check_circle</span>
                         <h3 className="text-2xl font-headline text-white">CORRECT</h3>
                     </div>
                 ) : (
                     <LargeWordInput 
                        value={inputValue}
                        onChange={setInputValue}
                        onEnter={checkAnswer}
                        placeholder="Type word..."
                     />
                 )}
             </div>

             {feedback === 'NONE' && (
                 <button 
                    onClick={checkAnswer}
                    disabled={!inputValue.trim()}
                    className="px-12 py-4 bg-electric-blue text-charcoal font-headline text-2xl rounded-xl hover:bg-white transition-all transform active:scale-95 disabled:opacity-50 disabled:transform-none"
                 >
                     CHECK
                 </button>
             )}
          </div>
      </div>
  );
};

export default App;