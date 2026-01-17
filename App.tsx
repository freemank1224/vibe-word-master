import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabaseClient';
import { Auth } from './components/Auth';
import { fetchUserData, fetchUserStats, saveSessionData, modifySession, updateWordStatus, getImageUrl, uploadImage, updateWordImage, updateWordStatusV2, deleteSessions, fetchUserAchievements, saveUserAchievement } from './services/dataService';
import { AppMode, WordEntry, InputSession, DayStats } from './types';
import { LargeWordInput } from './components/LargeWordInput';
import { CalendarView } from './components/CalendarView';
import { Confetti } from './components/Confetti';
import TestModeV2 from './components/TestModeV2';
import { aiService } from './services/ai';
import { fetchDictionaryData } from './services/dictionaryService';
import { playDing, playBuzzer, playAchievementUnlock } from './utils/audioFeedback';
import { AchievementsPanel } from './components/Achievements/AchievementsPanel';
import { calculateAchievements, ACHIEVEMENTS, Achievement } from './services/achievementService';
import { AchievementUnlockModal } from './components/Achievements/AchievementUnlockModal.tsx';
import { generateImagesForMissingWords } from './services/imageGenerationTask';
import { AccountPanel } from './components/AccountPanel';
import { LandingPage } from './components/LandingPage';
import { LibrarySelector } from './components/LibrarySelector';
import { DictionaryImporter } from './components/DictionaryImporter';


// Define Test Configuration State
interface TestConfig {
  sessionIds?: string[];
  wordIds?: string[];
}

const App: React.FC = () => {
  const [session, setSession] = useState<any>(null);
  const [showLanding, setShowLanding] = useState(true);
  const [mode, setMode] = useState<AppMode>('DASHBOARD');
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
              statsMap[s.date] = { date: s.date, total: s.total, correct: s.correct };
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
      generateImagesForMissingWords(session.user.id, (wordId, imagePath) => {
        // Optimistically update local state so user sees images appear in real-time
        setWords(prevWords => prevWords.map(w => {
          if (w.id === wordId) {
            return { ...w, image_path: imagePath, image_url: getImageUrl(imagePath) };
          }
          return w;
        }));
      }).catch(err => {
        console.error("Background image generation task failed", err);
      });
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


  // Reset reconciliation status when reloading data to prevent "Stale State" bugs
  useEffect(() => {
    if (loadingData) {
      setIsReconciled(false);
    }
  }, [loadingData]);

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
  
  // Helper to update local stats state immediately after test
  const updateLocalStats = (results: { correct: boolean }[]) => {
      const today = new Date().toISOString().split('T')[0];
      setDailyStats(prev => {
          const current = prev[today] || { date: today, total: 0, correct: 0 };
          
          // Note: This matches the "Sync Logic" in SQL - Distinct words count?
          // Actually, since we don't know easily if these specific words were ALREADY tested today locally without complex logic,
          // for the *immediate UI feedback* we might just assume we refresh stats or accept slight lag.
          // BUT: The user wants ACCURATE stats.
          // The best way: Start a background fetch of stats after test completes.
          return prev; 
      });
      // Trigger a fetch to get authoritative stats from DB (Sync outcome)
      if (session?.user) {
          setTimeout(() => {
             fetchUserStats(session.user.id).then(stats => {
                const statsMap: Record<string, DayStats> = {};
                stats.forEach((s: any) => {
                    statsMap[s.date] = { date: s.date, total: s.total, correct: s.correct };
                });
                setDailyStats(statsMap);
             });
          }, 1000); // Small delay to allow DB trigger/RPC to finish
      }
  };

  // Background Process
  const processBackgroundData = async (userId: string, wordsToProcess: any[]) => {
    if (!wordsToProcess || !Array.isArray(wordsToProcess)) return;
    for (const w of wordsToProcess) {
        // 1. Process Images
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

        // 2. Process Dictionary Info (Phonetic, Audio, Definition)
        try {
            const dict = await fetchDictionaryData(w.text);
            if (dict) {
                await updateWordStatusV2(w.id, {
                    correct: w.correct || false,
                    phonetic: dict.phonetic,
                    audio_url: dict.audioUrl,
                    definition_en: dict.definition_en
                });
                
                // Update local state if word still exists
                setWords(prev => prev.map(word => 
                    word.id === w.id 
                    ? { ...word, phonetic: dict.phonetic || null, audio_url: dict.audioUrl || null, definition_en: dict.definition_en || null } 
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
      let wordsToProcess = [];

      if (editingSessionId) {
        // UPDATE EXISTING SESSION
        // Words without IDs are new additions
        const addedWords = wordList.filter(w => !w.id); 
        console.log("Modifying session:", editingSessionId, "Added:", addedWords.length, "Deleted:", deletedIds.length);
        
        const { newWordsData } = await modifySession(session.user.id, editingSessionId, addedWords, deletedIds);
        wordsToProcess = newWordsData;
      } else {
        // CREATE NEW SESSION
        const { wordsData } = await saveSessionData(session.user.id, wordList.length, wordList);
        wordsToProcess = wordsData;
      }
      
      // RELOAD DATA IMMEDIATELY (Blocking)
      // This ensures that when we switch to dashboard, the data is FRESH.
      const { sessions: updatedSessions, words: updatedWords } = await fetchUserData(session.user.id);
      setSessions(updatedSessions);
      setWords(updatedWords);

      setMode('DASHBOARD');
      setEditingSessionId(null);

      // Trigger Background Process
      processBackgroundData(session.user.id, wordsToProcess);
      
    } catch (e) {
      console.error("Failed to save session", e);
      alert("Failed to save session to cloud. Check console for details.");
    }
  };

  const handleExecuteDelete = async () => {
      if (!session?.user || idsToDelete.length === 0) return;
      
      try {
          // 1. Delete from Cloud
          await deleteSessions(session.user.id, idsToDelete);

          // 2. Update Local State (Soft Delete)
          setSessions(prev => prev.map(s => idsToDelete.includes(s.id) ? { ...s, deleted: true } : s));
          setWords(prev => prev.map(w => idsToDelete.includes(w.sessionId) ? { ...w, deleted: true } : w));
          
          // 3. Clear Selection if deleted
          const newSelected = new Set(selectedDashboardSessionIds);
          idsToDelete.forEach(id => newSelected.delete(id));
          setSelectedDashboardSessionIds(newSelected);

          // 4. Close Modal
          setShowDeleteConfirm(false);
          setIdsToDelete([]);
          playDing(); // Success sound
      } catch (e) {
          console.error("Delete failed", e);
          alert("Failed to delete sessions. Check console.");
      }
  };

  const handleUpdateWordResult = async (id: string, correct: boolean) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, correct, tested: true } : w));
    await updateWordStatus(id, correct);
  };

  const handleInputModeDeleteWord = async (wordId: string) => {
      if (!session?.user) return;
      try {
          if (editingSessionId) {
             console.log("Deleting individual word:", wordId);
             await modifySession(session.user.id, editingSessionId, [], [wordId]);
             
             // Update local state immediately
             setWords(prev => prev.filter(w => w.id !== wordId));
             setSessions(prev => prev.map(s => 
                 s.id === editingSessionId 
                 ? { ...s, wordCount: Math.max(0, s.wordCount - 1) } 
                 : s
             ));
             playDing();
          }
      } catch (e) {
          console.error("Delete individual word failed", e);
          alert("Failed to delete word.");
      }
  };

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

  if (!session) {
    if (showLanding) {
      return <LandingPage onStart={() => setShowLanding(false)} />;
    }
    return <Auth />;
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
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <header className="h-16 border-b border-mid-charcoal bg-dark-charcoal/80 backdrop-blur-md sticky top-0 z-50 px-6 flex items-center justify-between">
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

      <main className="flex-1 p-4 md:p-8 max-w-[1400px] mx-auto w-full">
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
          />
        )}
        {mode === 'INPUT' && (
          <InputMode 
            initialWords={editingSessionId ? visibleWords.filter(w => w.sessionId === editingSessionId) : undefined}
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
            initialSessionIds={testConfig?.sessionIds || []}
            initialWordIds={testConfig?.wordIds}
            onUpdateWord={(id, updates) => {
                setWords(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
            }}
            onComplete={(results) => {
              updateLocalStats(results);
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
                        <span className="material-symbols-outlined text-4xl">warning</span>
                        <h3 className="text-2xl font-headline tracking-tight">CONFIRM DELETION</h3>
                    </div>
                    
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

      <footer className="py-6 text-center text-text-dark text-sm border-t border-mid-charcoal bg-dark-charcoal">
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
  onExpand: () => void 
}> = ({ sessions, selectedIds, onToggleSelect, onStartTest, onEdit, onDelete, onExpand }) => {
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
          className={`bg-light-charcoal rounded-xl border group transition-all flex flex-col justify-between overflow-hidden relative shadow-lg ${selectedIds.has(s.id) ? 'border-electric-green ring-1 ring-electric-green' : 'border-mid-charcoal hover:border-electric-blue'}`}
          style={{ padding: isHighDensity ? '0.75rem' : '1.5rem' }}
        >
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
  onDeleteSessions: (ids: string[]) => void
}> = ({ stats, sessions, words, selectedSessionIds, onToggleSessionSelect, onStartInput, onStartTest, onStartEdit, onOpenLibrary, onQuickTest, onDeleteSessions }) => {
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);

  // Filter words that already have images for the carousel
  const wordsWithImages = useMemo(() => words.filter(w => w.image_url), [words]);

  // 1. Auto-rotation logic (5 seconds)
  useEffect(() => {
    if (wordsWithImages.length <= 1) return;

    const timer = setInterval(() => {
      setCarouselIndex(prev => (prev + 1) % wordsWithImages.length);
    }, 5000);

    return () => clearInterval(timer);
  }, [wordsWithImages.length]);

  // 2. Initial Generation Logic (Fallback if no images exist)
  useEffect(() => {
    const triggerInitialGen = async () => {
      if (words.length > 0 && wordsWithImages.length === 0 && !isGenerating) {
        const randomWord = words[Math.floor(Math.random() * words.length)];
        setIsGenerating(true);
        try {
            // Note: generateImagesForMissingWords also runs in background in App,
            // but this ensures the featured area doesn't stay empty on first login.
            await aiService.generateImageHint(randomWord.text);
            // Words will update via the background task in App
        } catch (e) {
            console.warn("Initial featured generation failed", e);
        } finally {
            setIsGenerating(false);
        }
      }
    };
    triggerInitialGen();
  }, [words, wordsWithImages.length, isGenerating]);

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
              {isGenerating ? (
                <div className="flex flex-col items-center gap-4 p-8 text-center animate-pulse">
                  <span className="material-symbols-outlined text-5xl text-electric-blue">auto_awesome</span>
                  <p className="font-mono text-[10px] text-text-dark uppercase tracking-widest">Visualizing...</p>
                </div>
              ) : wordsWithImages.length > 0 ? (
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
    const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set(['Custom']));
    const [isImporterOpen, setIsImporterOpen] = useState(false);
    
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

    const filteredWords = sortedWords.filter(w => w.text.toLowerCase().includes(searchTerm.toLowerCase()));

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
                        <p className="font-mono text-[10px] text-text-dark uppercase">{libraryFilteredWords.length} WORDS ({selectedLibraries.has('All') ? 'ALL' : Array.from(selectedLibraries).join('+')})</p>
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

                {userId && (
                    <div className="mt-4">
                        <button 
                            onClick={() => setIsImporterOpen(!isImporterOpen)}
                            className="w-full text-xs text-mid-grey hover:text-white flex items-center gap-2 justify-center py-2 border border-transparent hover:border-mid-charcoal rounded transition-colors"
                        >
                            <span className="material-symbols-outlined text-sm">settings_ethernet</span>
                            {isImporterOpen ? 'Hide Dictionary Manager' : 'Manage Dictionaries'}
                        </button>
                        
                        {isImporterOpen && (
                            <div className="animate-in fade-in slide-in-from-top-2">
                                <DictionaryImporter 
                                    userId={userId} 
                                    onImportComplete={() => {
                                        if (onRefresh) onRefresh();
                                    }} 
                                />
                            </div>
                        )}
                    </div>
                )}
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
  onComplete: (words: { id?: string, text: string, imageBase64?: string }[], deletedIds: string[]) => void,
  onCancel: () => void,
  onDeleteWord?: (id: string) => Promise<void>,
  allWords: WordEntry[]
}> = ({ initialWords = [], onComplete, onCancel, onDeleteWord, allWords }) => {
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
          const audio = await aiService.generateSpeech(text);
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
                source.onended = () => setPlayingAudio(null);
                // Fallback for cleanup
                setTimeout(() => setPlayingAudio(null), audio.duration * 1000 + 500);
                return;
            }
          }
      } catch (e) {
          console.error("Audio error", e);
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
      // Local Check
      if (currentWords.some(w => w.text.toLowerCase() === trimmed.toLowerCase())) {
          setErrorMsg(`"${trimmed}" is already in the list.`);
          playBuzzer();
          return;
      }
      // Global Check
      const isGlobalDuplicate = allWords.some(w => w.text.toLowerCase() === trimmed.toLowerCase());
      if (isGlobalDuplicate) {
          setErrorMsg(`"${trimmed}" already exists in your library.`);
          playBuzzer();
          return;
      }

      setIsProcessing(true);
      const validation = await aiService.validateSpelling(trimmed);
      setIsProcessing(false);

      if (validation.serviceError) {
        setServiceErrorWord(trimmed);
        playBuzzer();
        return;
      }

      if (!validation.isValid) {
        playBuzzer();
        setErrorMsg(`Did you mean "${validation.suggestion || 'something else'}"?`);
        return;
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
    }
  };

  const initiateDelete = (index: number) => {
      setWordToDelete({ index, item: currentWords[index] });
  };

  const confirmDelete = async () => {
      if (!wordToDelete) return;

      // New word (not saved yet)
      if (!wordToDelete.item.id) {
          const newWords = [...currentWords];
          newWords.splice(wordToDelete.index, 1);
          setCurrentWords(newWords);
          setWordToDelete(null);
      } else {
          // Existing word - Immediate server sync requested
          if (onDeleteWord) {
              await onDeleteWord(wordToDelete.item.id);
              // Local update happens via prop update or manual splice if parent doesn't auto-refresh input list
              // Since we passed `initialWords`, `currentWords` is separate state. We must update it.
              const newWords = [...currentWords];
              newWords.splice(wordToDelete.index, 1);
              setCurrentWords(newWords);
          } else {
              // Fallback to old behavior if prop missing
              setDeletedIds(prev => [...prev, wordToDelete.item.id!]);
              const newWords = [...currentWords];
              newWords.splice(wordToDelete.index, 1);
              setCurrentWords(newWords);
          }
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
                     <p className="font-headline text-xl text-white truncate">{targetWord}</p>
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-6 animate-in fade-in duration-300">
            <div className="bg-light-charcoal border border-red-500/50 rounded-3xl p-8 max-w-[400px] w-full shadow-[0_0_30px_rgba(239,68,68,0.2)] scale-in-center">
                <h3 className="text-xl font-headline text-white mb-2">REMOVE WORD?</h3>
                <p className="text-text-dark mb-6 text-sm">
                    Are you sure you want to remove <span className="text-electric-blue font-bold">"{wordToDelete.item.text}"</span>?
                    {wordToDelete.item.id && " This will permanently delete it from your library."}
                </p>
                <div className="flex gap-4">
                    <button 
                        onClick={() => setWordToDelete(null)}
                        className="flex-1 py-3 rounded-xl bg-dark-charcoal text-text-light hover:bg-white hover:text-charcoal transition-colors font-mono text-xs uppercase"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={confirmDelete}
                        className="flex-1 py-3 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors font-headline tracking-wider text-sm shadow-lg"
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