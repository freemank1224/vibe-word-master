import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, isSupabaseConfigured } from './lib/supabaseClient';
import { Auth } from './components/Auth';
import { fetchUserData, saveSessionData, modifySession, updateWordStatus, getImageUrl, uploadImage, updateWordImage } from './services/dataService';
import { AppMode, WordEntry, InputSession, DayStats } from './types';
import { LargeWordInput } from './components/LargeWordInput';
import { CalendarView } from './components/CalendarView';
import { Confetti } from './components/Confetti';
import { aiService } from './services/ai';
import { playDing, playBuzzer } from './utils/audioFeedback';

// Define Test Configuration State
interface TestConfig {
  sessionIds?: string[];
  wordIds?: string[];
}

const App: React.FC = () => {
  const [session, setSession] = useState<any>(null);
  const [mode, setMode] = useState<AppMode>('DASHBOARD');
  const [words, setWords] = useState<WordEntry[]>([]);
  const [sessions, setSessions] = useState<InputSession[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // Edit Mode State
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  
  // Test Mode Configuration State
  const [testConfig, setTestConfig] = useState<TestConfig | null>(null);
  
  // Multi-Select State for Dashboard Testing
  const [selectedDashboardSessionIds, setSelectedDashboardSessionIds] = useState<Set<string>>(new Set());

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
  useEffect(() => {
    if (session?.user) {
      setLoadingData(true);
      setDataError(null);
      fetchUserData(session.user.id)
        .then(({ sessions, words }) => {
          setSessions(sessions);
          setWords(words);
        })
        .catch((err) => {
            console.error("Data load error:", err);
            setDataError("Failed to fetch data from the cloud. Please check your connection.");
        })
        .finally(() => setLoadingData(false));
    }
  }, [session]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setWords([]);
    setSessions([]);
  };

  // Derived Stats
  const getStats = (): Record<string, DayStats> => {
    const stats: Record<string, DayStats> = {};
    words.forEach(w => {
      const d = new Date(w.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!stats[key]) stats[key] = { date: key, total: 0, correct: 0 };
      stats[key].total++;
      if (w.correct) stats[key].correct++;
    });
    return stats;
  };

  // Background Process
  const processBackgroundImages = async (userId: string, wordsToProcess: any[]) => {
    if (!wordsToProcess || !Array.isArray(wordsToProcess)) return;
    for (const w of wordsToProcess) {
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
                console.warn(`Background generation failed for ${w.text}:`, e);
            }
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
      processBackgroundImages(session.user.id, wordsToProcess);
      
    } catch (e) {
      console.error("Failed to save session", e);
      alert("Failed to save session to cloud. Check console for details.");
    }
  };

  const handleUpdateWordResult = async (id: string, correct: boolean) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, correct, tested: true } : w));
    await updateWordStatus(id, correct);
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
          <h1 className="font-headline text-2xl tracking-tighter text-electric-blue">VOCAB VIBE</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-text-dark">
            <span className="material-symbols-outlined text-sm">cloud_done</span>
            <span>{session.user.email}</span>
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
            sessions={sessions}
            words={words}
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
          />
        )}
        {mode === 'INPUT' && (
          <InputMode 
            initialWords={editingSessionId ? words.filter(w => w.sessionId === editingSessionId) : undefined}
            onComplete={handleSaveSession}
            onCancel={() => {
                setEditingSessionId(null);
                setMode('DASHBOARD');
            }}
            allWords={words}
          />
        )}
        {mode === 'TEST' && (
          <TestMode 
            allWords={words}
            allSessions={sessions}
            initialSessionIds={testConfig?.sessionIds || []}
            initialWordIds={testConfig?.wordIds}
            onComplete={(results) => {
              results.forEach(res => handleUpdateWordResult(res.id, res.correct));
              setMode('DASHBOARD');
            }}
            onCancel={() => setMode('DASHBOARD')}
          />
        )}
        {mode === 'LIBRARY' && (
            <LibraryMode 
                words={words}
                onClose={() => setMode('DASHBOARD')}
                onTest={handleStartTestFromLibrary}
            />
        )}
      </main>

      <footer className="py-6 text-center text-text-dark text-sm border-t border-mid-charcoal bg-dark-charcoal">
        <p>&copy; 2024 VOCABVIBE MASTER - CLOUD SYNCED</p>
      </footer>
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
  onExpand: () => void 
}> = ({ sessions, selectedIds, onToggleSelect, onStartTest, onEdit, onExpand }) => {
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
                  onStartTest(s.id);
              }}
              className={`bg-mid-charcoal rounded-lg text-electric-green hover:bg-electric-green hover:text-charcoal transition-colors flex items-center justify-center z-20 ${isHighDensity ? 'p-1.5' : 'p-3'}`}
              title="Quick Test"
            >
              <span className={`material-symbols-outlined ${isHighDensity ? 'text-lg' : 'text-2xl'}`}>quiz</span>
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
  onOpenLibrary: () => void 
}> = ({ stats, sessions, words, selectedSessionIds, onToggleSessionSelect, onStartInput, onStartTest, onStartEdit, onOpenLibrary }) => {
  const [featuredImage, setFeaturedImage] = useState<string | null>(null);
  const [featuredWord, setFeaturedWord] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);

  useEffect(() => {
    const generateFeature = async () => {
      if (words.length > 0 && !featuredImage) {
        const randomWord = words[Math.floor(Math.random() * words.length)];
        setFeaturedWord(randomWord.text);
        if (randomWord.image_url) {
            setFeaturedImage(randomWord.image_url);
        } else {
            setIsGenerating(true);
            const img = await aiService.generateImageHint(randomWord.text);
            setFeaturedImage(img);
            setIsGenerating(false);
        }
      }
    };
    generateFeature();
  }, [words, featuredImage]);

  const totalCorrect = Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.correct, 0);
  const totalAll = Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.total, 0);
  const accuracy = (totalAll as number) > 0 ? (totalCorrect / totalAll) * 100 : 0;

  return (
    <div className="grid lg:grid-cols-12 gap-8 items-start animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="lg:col-span-8 flex flex-col gap-10">
        <div className="flex flex-col md:flex-row items-center gap-10">
          
          <div className="w-full md:w-80 h-80 flex-shrink-0 relative group order-last md:order-first">
            <div className="absolute -inset-1 bg-gradient-to-r from-electric-blue to-electric-purple rounded-3xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative w-full h-full bg-light-charcoal rounded-3xl border border-mid-charcoal overflow-hidden flex flex-col items-center justify-center">
              {isGenerating ? (
                <div className="flex flex-col items-center gap-4 p-8 text-center">
                  <span className="material-symbols-outlined text-5xl text-electric-blue animate-pulse">auto_awesome</span>
                  <p className="font-mono text-[10px] text-text-dark uppercase tracking-widest">Visualizing...</p>
                </div>
              ) : featuredImage ? (
                <>
                  <img src={featuredImage} alt="Featured Word AI" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark-charcoal via-transparent to-transparent opacity-80"></div>
                  <div className="absolute bottom-4 left-4 right-4">
                    <p className="text-[10px] font-mono text-electric-blue uppercase tracking-[0.2em] mb-1">Featured</p>
                    <p className="font-serif text-2xl text-white italic capitalize">{featuredWord}</p>
                  </div>
                </>
              ) : (
                <div className="p-8 text-center text-text-dark border-2 border-dashed border-mid-charcoal rounded-2xl m-4 h-full flex items-center">
                   <p className="font-mono text-xs">Add words to see AI-generated visual highlights here.</p>
                </div>
              )}
            </div>
          </div>

          <div className="text-center md:text-right flex-1 order-first md:order-last">
            <h2 className="text-6xl sm:text-8xl font-headline text-electric-blue leading-tight mb-4">
              EXPAND YOUR<br/>UNIVERSE.
            </h2>
            <p className="text-xl text-text-dark max-w-xl md:ml-auto">Master vocabulary with persistent cloud sync and AI visuals.</p>
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
                onClick={() => (sessions && sessions.length > 0) ? onStartTest([sessions[0].id]) : onStartInput()}
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
            {showAllSessions && (
                <button onClick={() => setShowAllSessions(false)} className="text-xs font-mono text-electric-blue hover:text-white uppercase">
                    Back to Matrix
                </button>
            )}
            {!showAllSessions && sessions.length > 0 && (
                <span className="text-xs font-mono text-text-dark opacity-50">{sessions.length} TOTAL</span>
            )}
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
                                <button onClick={() => onStartTest([s.id])} className="p-2 bg-mid-charcoal rounded-lg text-electric-green hover:bg-electric-green hover:text-charcoal transition-colors" title="Test">
                                    <span className="material-symbols-outlined text-lg">quiz</span>
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
                        onExpand={() => setShowAllSessions(true)}
                    />
                </div>
            )}
          </div>
        </div>
      </div>

      <div className="lg:col-span-4 space-y-8">
        <CalendarView stats={stats} />
        
        <div className="bg-light-charcoal p-6 rounded-2xl border border-mid-charcoal">
          <h3 className="font-headline text-xl text-electric-blue mb-4 tracking-widest uppercase">Global Impact</h3>
          <div className="space-y-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-electric-blue/10 rounded-lg text-electric-blue">
                <span className="material-symbols-outlined">school</span>
              </div>
              <div>
                <p className="text-xs text-text-dark uppercase font-bold">Accuracy</p>
                <p className="text-2xl font-mono text-white">
                    {totalCorrect} / {totalAll}
                </p>
              </div>
            </div>
            <div className="w-full bg-dark-charcoal rounded-full h-2">
                <div 
                    className="bg-electric-blue h-2 rounded-full shadow-[0_0_10px_rgba(0,240,255,0.5)]" 
                    style={{ width: `${accuracy}%` }}
                ></div>
            </div>
          </div>
        </div>

        {/* Word Library Card */}
        <div 
            onClick={onOpenLibrary}
            className="bg-light-charcoal p-6 rounded-2xl border border-mid-charcoal group hover:border-electric-blue cursor-pointer transition-all relative overflow-hidden"
        >
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-9xl text-white">local_library</span>
            </div>
            <h3 className="font-headline text-xl text-text-light mb-2 tracking-widest uppercase group-hover:text-electric-blue transition-colors">Word Library</h3>
            <p className="text-text-dark text-sm mb-6 relative z-10">Access your entire collection sorted alphabetically. Select specific ranges to reinforce memory.</p>
            
            <div className="flex items-center gap-3 relative z-10">
                <div className="bg-dark-charcoal p-3 rounded-lg border border-mid-charcoal group-hover:border-electric-blue/50 transition-colors">
                    <span className="font-mono text-electric-blue font-bold text-xl">{words.length}</span>
                </div>
                <span className="font-mono text-xs text-text-dark uppercase">Total Entries</span>
            </div>
            
            <div className="mt-6 flex items-center gap-2 text-electric-blue font-mono text-xs uppercase tracking-widest group-hover:translate-x-2 transition-transform relative z-10">
                <span>Open Archive</span>
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
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
}> = ({ words, onClose, onTest }) => {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [searchTerm, setSearchTerm] = useState('');
    const [randomCount, setRandomCount] = useState<string>('10');
    const [isMouseDown, setIsMouseDown] = useState(false);

    const sortedWords = useMemo(() => {
        return [...words].sort((a, b) => a.text.localeCompare(b.text));
    }, [words]);

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
        
        // Shuffle all word IDs
        const allIds = words.map(w => w.id);
        for (let i = allIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
        }
        
        const selected = allIds.slice(0, Math.min(count, allIds.length));
        setSelectedIds(new Set(selected));
    };

    const clearSelection = () => setSelectedIds(new Set());

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 animate-in fade-in slide-in-from-bottom-4 duration-500 h-[calc(100vh-100px)] flex flex-col md:flex-row gap-6">
            
            {/* Sidebar Tools */}
            <div className="w-full md:w-80 flex flex-col gap-6 flex-shrink-0">
                <div className="flex items-center gap-4 mb-2">
                     <button onClick={onClose} className="p-3 bg-mid-charcoal hover:bg-text-light hover:text-charcoal rounded-full transition-colors border border-mid-charcoal">
                        <span className="material-symbols-outlined">arrow_back</span>
                     </button>
                     <div>
                        <h2 className="font-headline text-3xl text-white tracking-wide">LIBRARY</h2>
                        <p className="font-mono text-[10px] text-text-dark uppercase">{words.length} TOTAL WORDS</p>
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
                            max={words.length}
                        />
                        <button 
                            onClick={handleRandomSelect}
                            className="flex-1 bg-mid-charcoal hover:bg-electric-blue hover:text-charcoal text-white rounded-lg px-4 py-2 font-headline tracking-wider transition-colors"
                        >
                            PICK RANDOM
                        </button>
                    </div>
                </div>

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
            <div className="flex-1 flex flex-col h-full bg-light-charcoal/50 rounded-2xl border border-mid-charcoal overflow-hidden relative">
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
  allWords: WordEntry[]
}> = ({ initialWords = [], onComplete, onCancel, allWords }) => {
  const [currentWords, setCurrentWords] = useState<{ id?: string, text: string, imageBase64?: string }[]>(
    initialWords.map(w => ({ id: w.id, text: w.text }))
  );
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAdd = async () => {
    setErrorMsg(null);
    const trimmed = inputValue.trim();
    if (trimmed) {
      // Local Check: Check duplicate in current session list
      if (currentWords.some(w => w.text.toLowerCase() === trimmed.toLowerCase())) {
          setErrorMsg(`"${trimmed}" is already in the list.`);
          playBuzzer();
          return;
      }

      // Global Check: Check duplicate in entire library
      // Exclude words marked for deletion in this session to allow re-adding
      const isGlobalDuplicate = allWords.some(w => 
        w.text.toLowerCase() === trimmed.toLowerCase() && 
        !deletedIds.includes(w.id)
      );

      if (isGlobalDuplicate) {
          setErrorMsg(`"${trimmed}" already exists in your library.`);
          playBuzzer();
          return;
      }

      setIsProcessing(true);
      const validation = await aiService.validateSpelling(trimmed);
      setIsProcessing(false);

      if (!validation.isValid) {
        playBuzzer();
        setErrorMsg(`Did you mean "${validation.suggestion || 'something else'}"?`);
        return;
      }

      const newEntry = { text: trimmed, imageBase64: undefined };
      setCurrentWords([...currentWords, newEntry]);
      setInputValue('');
      playDing();
    }
  };

  const handleRemove = (index: number) => {
    const wordToRemove = currentWords[index];
    if (wordToRemove.id) {
        setDeletedIds(prev => [...prev, wordToRemove.id!]);
    }
    const newWords = [...currentWords];
    newWords.splice(index, 1);
    setCurrentWords(newWords);
  };

  const handleSubmitSession = async () => {
    setIsSaving(true);
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
      }
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
            onClick={onCancel} 
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-light-charcoal border border-mid-charcoal text-text-light hover:text-white hover:border-electric-blue transition-all group"
         >
            <span className="material-symbols-outlined group-hover:-translate-x-1 transition-transform">arrow_back</span>
            <span className="font-mono text-xs uppercase tracking-wider">Dashboard</span>
         </button>
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

      <div className="relative">
        <LargeWordInput 
          value={inputValue} 
          onChange={(v) => {
            setInputValue(v);
            if (errorMsg) setErrorMsg(null); 
          }} 
          onEnter={handleAdd}
          placeholder="TYPE WORD..."
          disabled={isProcessing}
        />
        {isProcessing && (
          <div className="absolute inset-0 bg-charcoal/50 backdrop-blur-sm flex items-center justify-center rounded-xl z-10">
             <div className="flex items-center gap-3 text-electric-blue font-headline text-2xl animate-pulse">
                <span className="material-symbols-outlined animate-spin">sync</span>
                VALIDATING...
             </div>
          </div>
        )}
        
        {errorMsg && (
          <div className="absolute top-full left-0 right-0 mt-4 flex justify-center animate-in slide-in-from-top-2">
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-6 py-3 rounded-xl flex items-center gap-3 shadow-[0_0_20px_rgba(239,68,68,0.2)]">
               <span className="material-symbols-outlined">spellcheck</span>
               <span className="font-mono font-bold">{errorMsg}</span>
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
          onClick={handleAdd}
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
              <div key={i} className="group relative bg-light-charcoal p-4 rounded-xl border border-mid-charcoal text-center flex items-center justify-between hover:border-text-light transition-all">
                <span className="font-mono text-electric-blue truncate flex-1 text-left">{w.text}</span>
                <button 
                    onClick={() => handleRemove(i)}
                    className="ml-2 text-text-dark hover:text-red-500 transition-colors"
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
            disabled={currentWords.length === 0}
            className={`w-full max-w-md py-6 rounded-2xl font-headline text-3xl transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-3 disabled:opacity-50 disabled:transform-none bg-mid-charcoal text-text-light hover:bg-electric-green hover:text-charcoal border-2 border-transparent hover:border-white`}
        >
            <span className="material-symbols-outlined text-4xl">check_circle</span>
            {initialWords.length > 0 ? "UPDATE SESSION" : "FINISH & SAVE"}
        </button>
      </div>
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