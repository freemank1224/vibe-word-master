import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WordEntry, InputSession } from '../types';
import { updateWordStatusV2, updateWordMetadata } from '../services/dataService'; 
import { supabase } from '../lib/supabaseClient'; // Adjusted import for supabase
import { fetchDictionaryData, playWordAudio as playWordAudioService } from '../services/dictionaryService';
import { aiService } from '../services/ai';
import { playDing, playBuzzer, playCheer } from '../utils/audioFeedback';
import { LargeWordInput } from './LargeWordInput';
import { Confetti } from './Confetti';

interface TestModeV2Props {
  allWords: WordEntry[];
  sessions: InputSession[]; // Added sessions prop
  initialSessionIds: string[];
  initialWordIds?: string[];
  onComplete: (results: { id: string; correct: boolean; score: number }[]) => void;
  onCancel: () => void;
  onUpdateWord?: (id: string, updates: Partial<WordEntry>) => void;
}

const SyncOverlay = ({ showForceExit, onForceExit }: { showForceExit: boolean, onForceExit: () => void }) => (
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-300">
        <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-6"></div>
        <h3 className="text-2xl font-headline text-white mb-2 tracking-widest uppercase">Syncing Neural Database</h3>
        <p className="text-gray-500 font-mono text-sm mb-8">Please wait while we secure your progress...</p>
        
        {showForceExit && (
            <button 
                onClick={onForceExit}
                className="text-red-500 text-xs font-mono border-b border-red-500/30 pb-1 hover:text-red-400 hover:border-red-400 transition-colors cursor-pointer uppercase tracking-widest"
            >
                Force Exit
            </button>
        )}
    </div>
);

const HistoryCard = ({ result, word }: { result: { correct: boolean; score: number }, word: WordEntry }) => {
    let bgColor = 'bg-red-500/20 border-red-500/50 text-red-400';
    let statusIcon = 'close';

    if (result.score >= 3) {
        bgColor = 'bg-green-500/20 border-green-500/50 text-green-400';
        statusIcon = 'check';
    } else if (result.score > 0) { // Included 2.4 (Hint)
        bgColor = 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400';
        statusIcon = 'lightbulb';
    }

    return (
        <div className={`p-3 rounded-xl border flex items-center gap-3 backdrop-blur-md transition-all animate-in slide-in-from-right-4 duration-500 ${bgColor}`}>
            <span className="material-symbols-outlined text-sm">{statusIcon}</span>
            <div className="flex flex-col">
                <span className="font-bold text-sm tracking-wide text-white">{word.text}</span>
                <span className="text-[10px] font-mono opacity-80">{result.score.toFixed(1)} pts</span>
            </div>
        </div>
    );
};

const TestModeV2: React.FC<TestModeV2Props> = ({ 
  allWords, 
  sessions,
  initialSessionIds, 
  initialWordIds, 
  onComplete, 
  onCancel,
  onUpdateWord
}) => {
  const [coverage, setCoverage] = useState(100);
  const [tempCoverage, setTempCoverage] = useState(100);
  const [isSelectionConfirmed, setIsSelectionConfirmed] = useState(false);
  const [availablePool, setAvailablePool] = useState<WordEntry[]>([]);
  const [queue, setQueue] = useState<WordEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [feedback, setFeedback] = useState<'NONE' | 'CORRECT' | 'WRONG'>('NONE');
  const [hintLevel, setHintLevel] = useState(0); // 0: Audio, 1: Letter Blocks, 2: Image + Meaning
  const [isRevealed, setIsRevealed] = useState(false);
  const [startTime, setStartTime] = useState<number>(0);
  
  // Updated Results State
  const [results, setResults] = useState<{ id: string; correct: boolean; score: number }[]>([]);
  
  // New Logic States
  const [currentAttempts, setCurrentAttempts] = useState(0);
  const [hasUsedHint, setHasUsedHint] = useState(false);
  
  // Exit/Sync States
  const [isSyncing, setIsSyncing] = useState(false);
  const [showForceExit, setShowForceExit] = useState(false);
  
  const [isFinished, setIsFinished] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [confettiConfig, setConfettiConfig] = useState<{title?: string, subtitle?: string, variant?: 'green' | 'blue' | 'purple', showParticles?: boolean}>({});
  const [streak, setStreak] = useState(0);
  const [isStarted, setIsStarted] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [notification, setNotification] = useState<{message: string, type: 'info' | 'error' | 'success'} | null>(null);

  // Loading States & Refs
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [isResourcesLoaded, setIsResourcesLoaded] = useState(false);
  const [missingResources, setMissingResources] = useState<{images: number, audio: number}>({ images: 0, audio: 0 });
  const resourceCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const objectUrlsRef = useRef<string[]>([]);
  const isMountedRef = useRef(true);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Lifecycle
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Milestone tracking settings
  const milestonesReached = useRef<Set<string>>(new Set());
  const nextTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Time tracking
  const [elapsedTime, setElapsedTime] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Audio References
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentAudioSourceRef = useRef<AudioBufferSourceNode | HTMLAudioElement | null>(null);
  const activeWordIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (showConfetti) {
      const t = setTimeout(() => setShowConfetti(false), 5000);
      return () => clearTimeout(t);
    }
  }, [showConfetti]);

  useEffect(() => {
    // Determine the pool of words based on initial configuration
    if (availablePool.length === 0) {
      let pool: WordEntry[] = [];
      if (initialWordIds && initialWordIds.length > 0) {
        pool = allWords.filter(w => initialWordIds.includes(w.id));
      } else if (initialSessionIds.length > 0) {
        pool = allWords.filter(w => initialSessionIds.includes(w.sessionId));
      }
      
      if (pool.length > 0) {
        // Ensure uniqueness by word text (standardize to lowercase for comparison)
        const uniqueTextMap = new Map();
        pool.forEach(item => {
            const key = item.text.toLowerCase().trim();
            if (!uniqueTextMap.has(key)) {
                uniqueTextMap.set(key, item);
            }
        });
        setAvailablePool(Array.from(uniqueTextMap.values()));
      }
    }
  }, [allWords, initialSessionIds, initialWordIds, availablePool.length]);

  useEffect(() => {
    // Regenerate queue when coverage is confirmed or updated, but only before starting
    if (isStarted || availablePool.length === 0 || !isSelectionConfirmed) return;

    const generateQueue = async () => {
        setIsOptimizing(true);
        const targetCount = Math.max(1, Math.round((availablePool.length * coverage) / 100));
        
        // Check for AI Optimization
        const isAiEnabled = localStorage.getItem('vibe_ai_selection') === 'true';
        
        if (isAiEnabled) {
            try {
                // 1. Build Candidate Pools
                const currentIds = new Set(availablePool.map(w => w.id));

                const historyCandidates = allWords.filter(w => !currentIds.has(w.id) && !w.deleted);

                const mistakeCandidates = allWords.filter(w => 
                    !currentIds.has(w.id) && !w.deleted && 
                    ((w.tags && w.tags.includes('Mistake')) || w.error_count > 0 || (w.score !== undefined && w.score < 3))
                );

                // 2. Create the "Smart Report" List (Limit to 100 for token efficiency)
                const finalCandidates: WordEntry[] = [...availablePool];
                
                // Fill up to 100 with mistakes first
                if (finalCandidates.length < 100) {
                    const sortedMistakes = mistakeCandidates.sort((a,b) => b.error_count - a.error_count);
                    for (const m of sortedMistakes) {
                        if (finalCandidates.length >= 100) break;
                        if (!finalCandidates.find(w => w.id === m.id)) {
                            finalCandidates.push(m);
                        }
                    }
                }

                // Fill remainder with history (stale words first)
                if (finalCandidates.length < 100) {
                    const sortedHistory = historyCandidates.sort((a,b) => (a.last_tested || 0) - (b.last_tested || 0));
                    for (const h of sortedHistory) {
                        if (finalCandidates.length >= 100) break;
                        if (!finalCandidates.find(w => w.id === h.id)) {
                            finalCandidates.push(h);
                        } 
                    }
                }

                // 3. Call AI Service
                const optimizedIds = await aiService.optimizeWordSelection(finalCandidates, sessions, targetCount);

                if (optimizedIds && optimizedIds.length > 0) {
                    const aiQueue = allWords.filter(w => optimizedIds.includes(w.id));
                    
                    if (aiQueue.length < targetCount) {
                        const remaining = targetCount - aiQueue.length;
                        const remainderPool = availablePool.filter(w => !optimizedIds.includes(w.id));
                        for (let i = remainderPool.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [remainderPool[i], remainderPool[j]] = [remainderPool[j], remainderPool[i]];
                        }
                        aiQueue.push(...remainderPool.slice(0, remaining));
                    }

                    for (let i = aiQueue.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [aiQueue[i], aiQueue[j]] = [aiQueue[j], aiQueue[i]];
                    }
                    
                    setQueue(aiQueue);
                    setIsOptimizing(false);
                    return;
                }
            } catch (e: any) {
                console.warn("AI Selection failed, falling back to random:", e);
                setNotification({
                    type: 'error',
                    message: `AI Optimization Unavailable: ${e?.message || 'Unknown error'}. Switching to Standard Mode.`
                });
                setTimeout(() => setNotification(null), 4000);
            }
        }

        // Standard Random Shuffle (Fallback or Default)
        const shuffled = [...availablePool];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        setQueue(shuffled.slice(0, targetCount));
        setIsOptimizing(false);
    };

    generateQueue();
  }, [availablePool, coverage, isStarted, isSelectionConfirmed, allWords, sessions]);

  useEffect(() => {
    // Cleanup audio on unmount
    return () => {
        if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
        activeWordIdRef.current = null;
        if (currentAudioSourceRef.current) {
            try {
                if (currentAudioSourceRef.current instanceof HTMLAudioElement) {
                    currentAudioSourceRef.current.pause();
                } else {
                    (currentAudioSourceRef.current as AudioBufferSourceNode).stop();
                }
            } catch (e) {}
        }
        window.speechSynthesis.cancel();
    };
  }, []);

  // Preloading Effect
  useEffect(() => {
    if (queue.length === 0) return;

    const loadResources = async () => {
        setIsResourcesLoaded(false);
        setLoadingProgress({ current: 0, total: queue.length });
        setMissingResources({ images: 0, audio: 0 });
        
        let completed = 0;
        let missingImg = 0;
        let missingAud = 0;
        
        // Use a concurrency limit to avoid overwhelming the network/APIs
        const batchSize = 2; // Reduced to 2 for even better stability on mobile/slow nets

        for (let i = 0; i < queue.length; i += batchSize) {
            if (!isMountedRef.current) break;
            const batch = queue.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (word) => {
                if (!isMountedRef.current) return;
                try {
                    // 1. Fetch Dictionary Data to get CORS-friendly audio URLs
                    let audioUrl = word.audio_url;
                    
                    // Always try to get better audio from dictionary API (CORS-friendly sources)
                    try {
                        const data = await fetchDictionaryData(word.text, word.language || 'en');
                        if (data?.audioUrl) {
                            audioUrl = data.audioUrl;
                            word.audio_url = audioUrl; // Update local reference
                            if (data.phonetic) word.phonetic = data.phonetic;
                            
                            // Save to DB for future use (Lazy update)
                            updateWordMetadata(word.id, { 
                                audio_url: audioUrl, 
                                phonetic: data.phonetic || word.phonetic || undefined,
                                definition_en: data.definition_en || word.definition_en || undefined
                            });
                        }
                    } catch (e) { 
                        console.warn("Dictionary fetch failed for", word.text);
                    }

                    // 2. Preload Audio only if we have a CORS-friendly URL
                    // Dictionary API provides URLs from sources like api.dictionaryapi.dev which support CORS
                    if (audioUrl && !audioUrl.includes('youdao.com')) {
                        try {
                            const audio = new Audio();
                            audio.preload = 'auto';
                            audio.crossOrigin = 'anonymous';
                            audio.src = audioUrl;

                            await new Promise<void>((resolve) => {
                                const timeoutId = setTimeout(() => resolve(), 10000); // 10s for audio
                                audio.oncanplaythrough = () => {
                                    clearTimeout(timeoutId);
                                    resolve();
                                };
                                audio.onerror = () => {
                                    clearTimeout(timeoutId);
                                    missingAud++;
                                    resolve();
                                };
                                audio.load(); // Force load
                            });
                            resourceCacheRef.current.set(word.id, audio);
                        } catch (e) {
                            missingAud++;
                        }
                    } else {
                        // No preloadable audio - will use Speech Synthesis fallback at runtime
                        missingAud++;
                    }

                    // 3. Preload Image
                    if (word.image_url) {
                        await new Promise<void>((resolve) => {
                             const img = new Image();
                             const timeoutId = setTimeout(() => resolve(), 5000);
                             img.onload = () => {
                                 clearTimeout(timeoutId);
                                 resolve();
                             };
                             img.onerror = () => {
                                 clearTimeout(timeoutId);
                                 missingImg++;
                                 resolve();
                             };
                             img.src = word.image_url!;
                        });
                    } else {
                        missingImg++;
                    }

                } catch (e) {
                    console.warn("Resource load failed for", word.text);
                } finally {
                    if (isMountedRef.current) {
                        completed++;
                        setLoadingProgress({ current: completed, total: queue.length });
                    }
                }
            }));
        }
        
        if (isMountedRef.current) {
            setMissingResources({ images: missingImg, audio: missingAud });
            setIsResourcesLoaded(true);
        }
    };

    loadResources();

    return () => {
        // 1. Stop and cleanup current audio elements
        resourceCacheRef.current.forEach(audio => {
            try {
                audio.pause();
                audio.src = "";
                audio.removeAttribute('src'); 
                audio.load(); 
            } catch (e) {}
        });
        resourceCacheRef.current.clear();

        // 2. Revoke all object URLs to free memory
        objectUrlsRef.current.forEach(url => {
            try {
                URL.revokeObjectURL(url);
            } catch (e) {}
        });
        objectUrlsRef.current = [];
    };
  }, [queue]);

  useEffect(() => {
    if (queue.length > 0 && !isFinished && isStarted) {
        timerRef.current = setInterval(() => {
            setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
        }, 1000);
    }
    return () => {
        if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [queue.length, isFinished, startTime, isStarted]);

  const currentWord = queue[currentIndex];

  const stopAudio = useCallback(() => {
    // 1. Stop all cached audio elements to prevent overlaps during transitions
    resourceCacheRef.current.forEach(audio => {
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch (e) { /* ignore */ }
    });
    
    // 2. Stop ad-hoc audio (TTS or non-cached)
    if (currentAudioSourceRef.current) {
        try {
            if (currentAudioSourceRef.current instanceof HTMLAudioElement) {
                currentAudioSourceRef.current.pause();
                currentAudioSourceRef.current.currentTime = 0;
            } else {
                (currentAudioSourceRef.current as AudioBufferSourceNode).stop();
            }
        } catch (e) {
            // Ignore errors if already stopped
        }
        currentAudioSourceRef.current = null;
    }
    
    // 3. Stop System TTS
    window.speechSynthesis.cancel();
    setIsPlayingAudio(false);
  }, []);

  useEffect(() => {
    // Global safety cleanup when 'isStarted' becomes false or component unmounts
    // Although main cleanup is in unmount effect, this handles immediate exit from Test UI
    if (!isStarted) {
        stopAudio();
    }
  }, [isStarted, stopAudio]);

  const playAudio = useCallback(async (word: WordEntry) => {
    if (!isMountedRef.current) return;
    
    // 1. Mark this word as the intended target for audio
    activeWordIdRef.current = word.id;
    
    // We already stop in the transition effect, but double-check here
    stopAudio();
    setIsPlayingAudio(true);
    
    try {
        // Try cached audio first (from preloading)
        const cachedAudio = resourceCacheRef.current.get(word.id);
        if (cachedAudio) {
            currentAudioSourceRef.current = cachedAudio;
            cachedAudio.onended = () => {
                if(isMountedRef.current) setIsPlayingAudio(false);
            };
            try {
                await cachedAudio.play();
                return; // Success!
            } catch (err) {
                console.warn("Cached audio play failed, falling back", err);
            }
        }

        // Double check before playing
        if (activeWordIdRef.current !== word.id) return;

        // Use the unified audio service that handles CORS issues
        const success = await playWordAudioService(word.text, word.language || 'en');
        
        if (isMountedRef.current) {
            setIsPlayingAudio(false);
        }
        
        if (!success) {
            console.warn("All audio methods failed for:", word.text);
        }
    } catch (e) {
        console.error("Audio playback error", e);
        // Only reset if we are still the active word
        if (activeWordIdRef.current === word.id && isMountedRef.current) {
            setIsPlayingAudio(false);
        }
    }
  }, [stopAudio]);

  useEffect(() => {
    // Auto-play audio when word changes IN SESSION
    if (currentWord && !isFinished && !isRevealed && feedback === 'NONE' && isStarted) {
        // IMPORTANT: Stop any previous audio IMMEDIATELY when the word changes
        // even before the 300ms delay to prevent hearing the wrong word.
        stopAudio();
        
        // Sync active ID immediately
        activeWordIdRef.current = currentWord.id;
        
        // Small delay to ensure UI transition is smooth
        const t = setTimeout(() => {
            if (activeWordIdRef.current === currentWord.id && isMountedRef.current) {
                playAudio(currentWord);
            }
        }, 300);
        return () => clearTimeout(t);
    }
  }, [currentIndex, isFinished, isStarted, playAudio, currentWord, feedback, isRevealed]); 

  const handleHint = () => {
      setHintLevel(prev => Math.min(prev + 1, 2));
      setHasUsedHint(true);
  };
  
  // Tag "Mistake" helper
  const addMistakeTag = async (wordId: string, currentTags: string[] = []) => {
      if (currentTags.includes('Mistake')) return;
      
      const newTags = [...currentTags, 'Mistake'];
      const { error } = await supabase
        .from('words')
        .update({ tags: newTags })
        .eq('id', wordId);
        
      if (error) console.error("Failed to tag word as Mistake:", error.message);
  };

  const handleNext = useCallback(async (score: number) => {
      // Clear any pending timeouts
      if (nextTimeoutRef.current) {
          clearTimeout(nextTimeoutRef.current);
          nextTimeoutRef.current = null;
      }

      // Check if we are done
      if (!currentWord) return;

      const success = score > 0;
      const wordStartTime = startTime; 
      
      // 1. Sync to Database - updateWordStatusV2 handles tested and last_tested internally
      const dbUpdates = {
          correct: success,
          score: score,
          error_count_increment: success ? 0 : 1,
          best_time_ms: success ? (Date.now() - wordStartTime) : undefined
      };

      try {
        await updateWordStatusV2(currentWord.id, dbUpdates);
        
        // --- NEW LOGIC: Add to Mistake Bank if Score is 0 ---
        if (!success) {
            addMistakeTag(currentWord.id, currentWord.tags);
        }
        // ----------------------------------------------------
      } catch (e) {
        console.error("Failed to sync word status to DB:", e);
      }

      // 2. Real-time Local Update (for Calendar/Library synchronization)
      if (onUpdateWord) {
          const newErrorCount = (currentWord.error_count || 0) + (success ? 0 : 1);
          // If 0 score (failed), we optimistically add the tag locally too
          const newTags = !success && !(currentWord.tags || []).includes('Mistake')
            ? [...(currentWord.tags || []), 'Mistake']
            : currentWord.tags;

          onUpdateWord(currentWord.id, {
              correct: success,
              score: score,
              tested: true,
              last_tested: Date.now(),
              error_count: newErrorCount,
              tags: newTags
          });
      }

      const newResults = [...results, { id: currentWord.id, correct: success, score }];
      setResults(newResults);
      
      if (success) {
          setStreak(prev => prev + 1);
          
          // Celebration Logic
          const progress = (newResults.length / queue.length);
          const isLastWord = currentIndex >= queue.length - 1;

          if (isLastWord) {
            setConfettiConfig({
                variant: 'green',
                showParticles: true
            });
            setShowConfetti(true);
            
            // If every word in the results was correct (plus the final one)
            const allCorrectSoFar = newResults.every(r => r.correct);
            if (allCorrectSoFar) {
                // Perfect score cheer!
                playCheer();
            }
          } else if (queue.length >= 20) {
            // Milestone 1/3
            if (progress >= 0.33 && !milestonesReached.current.has('1/3')) {
                milestonesReached.current.add('1/3');
                setConfettiConfig({
                    variant: 'blue',
                    showParticles: true
                });
                setShowConfetti(true);
            } 
            // Milestone 2/3
            else if (progress >= 0.66 && !milestonesReached.current.has('2/3')) {
                milestonesReached.current.add('2/3');
                setConfettiConfig({
                    variant: 'purple',
                    showParticles: true
                });
                setShowConfetti(true);
            }
          }
      } else {
          setStreak(0);
      }

      if (currentIndex >= queue.length - 1) {
          setTimeout(() => setIsFinished(true), 1500); // Shorter delay
      } else {
          setCurrentIndex(prev => prev + 1);
          setInputValue('');
          setFeedback('NONE');
          setHintLevel(0);
          setIsRevealed(false);
          setIsProcessing(false); // Reset lock
          setStartTime(Date.now());
          setCurrentAttempts(0);
          setHasUsedHint(false);
      }
  }, [currentIndex, queue, results, startTime, onUpdateWord, streak, currentWord]);

  const handleReveal = () => {
      setIsRevealed(true);
      setFeedback('WRONG');
      playBuzzer();
  };

  const checkAnswer = () => {
      if (isProcessing || !currentWord) return;
      
      // If revealed, assume user wants to move on (Next with 'WRONG')
      if (isRevealed) {
          handleNext(0);
          return;
      }
      
      // If already correct, just ensure next is called (safety)
      if (feedback === 'CORRECT') {
          return;
      }

      const normalizedInput = inputValue.trim().toLowerCase();
      const normalizedTarget = currentWord.text.trim().toLowerCase();

      if (normalizedInput === normalizedTarget) {
          setIsProcessing(true); // Lock
          setFeedback('CORRECT');
          playDing();
          
          // Score Calculation
          let score = 0;
          if (hasUsedHint) {
              score = 2.4;
          } else if (currentAttempts < 3) {
              score = 3;
          } else {
              // Should not happen with new fail logic, but safe fallback
              score = 0;
          }

          // Auto-advance
          nextTimeoutRef.current = setTimeout(() => handleNext(score), 1200);
      } else {
          // --- WRONG ANSWER LOGIC ---
          setIsProcessing(false); // Ensure unlocked
          playBuzzer();
          
          // Check Hints first (Unlimited attempts)
          if (hasUsedHint) {
              setFeedback('WRONG');
              // No attempt limit
              return;
          } 

          // Standard Mode (Limit 3)
          // Current attempts starts at 0.
          // 1st Fail: attempts 0 -> 1. User sees 'WRONG'.
          // 2nd Fail: attempts 1 -> 2. User sees 'WRONG'.
          // 3rd Fail: attempts 2 -> 3. User SEES 'WRONG' briefly then MOVES ON.
          
          const nextAttemptCount = currentAttempts + 1;
          
          if (nextAttemptCount >= 3) {
              // Trigger Failure
              setFeedback('WRONG');
              setIsProcessing(true); // Lock input
              // Wait 1s then move next with 0 score
              setTimeout(() => {
                  handleNext(0);
              }, 1000);
          } else {
             setFeedback('WRONG');
             setCurrentAttempts(nextAttemptCount);
          }
      }
  };

  const handleExit = (action: 'COMPLETE' | 'CANCEL') => {
      setIsSyncing(true);
      
      syncTimeoutRef.current = setTimeout(() => {
          setShowForceExit(true);
      }, 5000);
      
      setTimeout(() => {
          if (action === 'COMPLETE') {
              onComplete(results);
          } else {
              onCancel();
          }
      }, 1500);
  };

  if (isFinished) {
      const correctCount = results.filter(r => r.correct).length;
      const totalPoints = results.reduce((sum, r) => sum + r.score, 0);
      const maxPoints = queue.length * 3;
      const accuracy = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;
      
      const getEmoji = (acc: number) => {
          if (acc === 100) return '🏆';
          if (acc >= 80) return '🔥';
          if (acc >= 60) return '⭐';
          if (acc >= 40) return '💪';
          return '📚';
      };

      return (
        <div className="fixed top-16 inset-x-0 bottom-0 bg-[#0a0a0a] flex flex-col items-center justify-center p-8 z-50 text-white animate-in fade-in duration-700">
          {isSyncing && <SyncOverlay showForceExit={showForceExit} onForceExit={onCancel} />}
          <Confetti showParticles={true} variant={accuracy >= 80 ? 'purple' : 'blue'} />
          
          <div className="text-8xl mb-6 animate-bounce">
              {getEmoji(accuracy)}
          </div>

          <h2 className="text-4xl font-headline mb-4 tracking-tighter uppercase">Test Complete!</h2>
          <div className={`text-7xl font-black mb-4 ${accuracy >= 80 ? 'text-electric-green' : accuracy >= 60 ? 'text-electric-blue' : 'text-orange-500'}`}>
            {accuracy}%
          </div>
          <div className="flex flex-col items-center gap-2 mb-8 font-mono text-gray-400">
             <p>Correct Words: <span className="text-white">{correctCount} / {queue.length}</span></p>
             <p>Total Points: <span className="text-electric-blue">{totalPoints.toFixed(1)} / {maxPoints}</span> pts</p>
             <p>Time: {elapsedTime}s</p>
          </div>
          
          <button 
            onClick={() => handleExit('COMPLETE')}
            className="px-12 py-4 bg-white text-black rounded-2xl font-headline text-xl hover:bg-electric-blue hover:text-white transition-all transform hover:scale-105 active:scale-95 shadow-xl"
          >
            RESTORE SYSTEM
          </button>
        </div>
      );
  }

  if (!isStarted) {
    return (
        <div className="fixed top-16 inset-x-0 bottom-0 bg-[#0a0a0a] flex flex-col items-center justify-center p-8 z-50 text-white">
            {isSyncing && <SyncOverlay showForceExit={showForceExit} onForceExit={onCancel} />}
            <div className="max-w-md w-full text-center">
                <div className="w-36 h-36 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-8 border border-white/10 overflow-hidden group">
                    <img 
                      src={`/monsterImages/M${new Date().getDay()}.webp`} 
                      alt="Monster" 
                      className="w-32 h-32 object-contain transition-transform duration-500 group-hover:scale-110"
                    />
                </div>
                <h2 className="text-4xl font-headline mb-4 tracking-tight uppercase">Ready to Vibe?</h2>
                <p className="text-gray-400 mb-2 font-body leading-relaxed">
                    You're about to test <span className="text-white font-bold">{isSelectionConfirmed ? queue.length : Math.max(1, Math.round((availablePool.length * tempCoverage) / 100))} words</span>. 
                </p>
                <p className="text-xs text-gray-500 mb-8 font-body">
                    Listen carefully to the audio and spell the word correctly.
                </p>

                {/* Coverage Slider */}
                <div className="mb-10 w-full max-w-xs mx-auto text-left">
                    <div className="flex justify-between items-end mb-3">
                        <span className="text-[10px] font-mono text-gray-500 uppercase tracking-[0.2em]">Test Coverage</span>
                        <span className="text-lg font-headline text-blue-500 leading-none">
                            {tempCoverage}% <span className="text-xs text-gray-500 font-mono ml-1">({Math.max(1, Math.round((availablePool.length * tempCoverage) / 100))} words)</span>
                        </span>
                    </div>
                    <input 
                        type="range" 
                        min="1" 
                        max="100" 
                        value={tempCoverage} 
                        onChange={(e) => setTempCoverage(parseInt(e.target.value))}
                        onMouseUp={() => {
                            setCoverage(tempCoverage);
                            setIsSelectionConfirmed(true);
                        }}
                        onTouchEnd={() => {
                            setCoverage(tempCoverage);
                            setIsSelectionConfirmed(true);
                        }}
                        className="w-full h-1 bg-gray-800 rounded-full appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400 transition-all transition-thumb mb-2"
                    />
                    <div className="flex justify-between text-[10px] font-mono text-gray-600">
                        <span>LITE</span>
                        <span>FULL COLLECTION</span>
                    </div>
                </div>

                {/* Loading Progress Bar */}
                <div className="mb-10 w-full max-w-xs mx-auto">
                    <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden mb-2">
                         <div 
                            className={`h-full transition-all duration-300 ${!isSelectionConfirmed ? 'bg-gray-700' : (isResourcesLoaded && !isOptimizing) ? 'bg-green-500' : 'bg-blue-500'}`}
                            style={{ width: `${!isSelectionConfirmed ? 0 : (isOptimizing ? 100 : (loadingProgress.current / Math.max(loadingProgress.total, 1)) * 100)}%` }}
                         />
                    </div>
                    <div className="flex justify-between text-xs font-mono text-gray-500">
                      <span>
                        {!isSelectionConfirmed 
                            ? 'IDLE' 
                            : isOptimizing 
                                ? 'OPTIMIZING NEURAL PATHWAYS...' 
                                : isResourcesLoaded 
                                    ? 'READY' 
                                    : 'LOADING RESOURCES...'}
                      </span>
                      <span>
                        {!isSelectionConfirmed 
                            ? '0%' 
                            : isOptimizing 
                                ? 'AI' 
                                : Math.round((loadingProgress.current / Math.max(loadingProgress.total, 1)) * 100) + '%'}
                      </span>
                    </div>

                    {isResourcesLoaded && !isOptimizing && missingResources.images > 0 && (
                        <div className="mt-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex gap-3 text-left animate-in fade-in slide-in-from-bottom-2">
                             <svg className="w-5 h-5 text-yellow-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                             <div>
                                 <p className="text-xs text-yellow-200 font-bold mb-0.5">Warning: Missing Visuals</p>
                                 <p className="text-[10px] text-yellow-500/80 leading-relaxed">
                                     {missingResources.images} images failed to load. You can continue, but hints will be limited to Audio/Definitions.
                                 </p>
                             </div>
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-4">
                    <button 
                        onClick={() => {
                            if (!isSelectionConfirmed) {
                                setCoverage(tempCoverage);
                                setIsSelectionConfirmed(true);
                            } else {
                                setIsStarted(true);
                                setStartTime(Date.now());
                            }
                        }}
                        disabled={isSelectionConfirmed && (!isResourcesLoaded || isOptimizing)}
                        className={`w-full px-8 py-4 text-black rounded-2xl font-headline text-xl transition-all transform duration-300
                            ${(!isSelectionConfirmed || (isResourcesLoaded && !isOptimizing))
                                ? 'bg-blue-500 hover:bg-blue-400 hover:scale-[1.02] active:scale-95 shadow-[0_0_20px_rgba(59,130,246,0.3)] cursor-pointer' 
                                : 'bg-gray-800 text-gray-500 cursor-not-allowed opacity-50'}`}
                    >
                        {!isSelectionConfirmed 
                            ? 'PREPARE NEURAL LINK' 
                            : isOptimizing 
                                ? 'ANALYZING BRAINWAVES...'
                                : isResourcesLoaded 
                                    ? (missingResources.images > 0 ? 'START ANYWAY' : 'START SESSION') 
                                    : 'SYNCING...'}
                    </button>
                    <button 
                        onClick={() => handleExit('CANCEL')}
                        className="w-full px-8 py-4 bg-transparent text-gray-500 rounded-2xl font-mono text-sm hover:text-white transition-colors"
                    >
                        GO BACK
                    </button>
                </div>
            </div>
        </div>
    );
  }

  if (!currentWord) return null;

  // New: Get Reversed History for Display
  const historyItems = [...results].reverse(); 

  return (
    <div className="fixed top-16 inset-x-0 bottom-0 bg-[#0a0a0a] flex flex-col z-50 text-white overflow-hidden">
      {isSyncing && <SyncOverlay showForceExit={showForceExit} onForceExit={onCancel} />}
      {showConfetti && <Confetti {...confettiConfig} />}
      {notification && (
        <div className={`fixed top-4 left-1/2 transform -translate-x-1/2 z-[200] px-6 py-3 rounded-xl border shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 duration-300
            ${notification.type === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-200' : 'bg-blue-500/10 border-blue-500/30 text-blue-200'}`}>
            <span className="material-symbols-outlined text-lg">
                {notification.type === 'error' ? 'warning' : 'info'}
            </span>
            <span className="font-mono text-xs font-bold">{notification.message}</span>
        </div>
      )}
      
      {/* Top Progress Bar */}
      <div className="h-2 w-full bg-gray-900 border-b border-white/5">
        <div 
          className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500 ease-out shadow-[0_0_15px_rgba(59,130,246,0.5)]" 
          style={{ width: `${((currentIndex + 1) / queue.length) * 100}%` }}
        />
      </div>

      {/* Header */}
      <div className="p-6 flex justify-between items-center bg-[#0a0a0a]/50 backdrop-blur-sm z-10 relative">
        <div className="flex items-center gap-4">
            <button onClick={() => handleExit('CANCEL')} className="p-2 bg-white/5 hover:bg-white/10 rounded-xl text-gray-500 hover:text-white transition-all">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
            <div className="flex flex-col">
                <span className="text-[10px] font-mono text-gray-600 uppercase tracking-widest leading-none mb-1">Progress</span>
                <span className="text-sm font-bold font-mono text-blue-500">{currentIndex + 1} / {queue.length}</span>
            </div>
        </div>
        <div className="flex items-center gap-8">
            <div className="flex flex-col items-end">
                <span className="text-[10px] text-gray-600 uppercase tracking-widest leading-none mb-1">Time Elapsed</span>
                <span className="font-mono text-white">{elapsedTime}s</span>
            </div>
            <div className="flex flex-col items-end">
                <span className="text-[10px] text-gray-600 uppercase tracking-widest leading-none mb-1">Streak</span>
                <span className="font-mono text-orange-500 font-bold">{streak}</span>
            </div>
        </div>
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto no-scrollbar pb-20">
        <div className="flex flex-col items-center justify-center p-4 min-h-[500px]">
            {/* The Main Card */}
            <div className="relative w-full max-w-2xl aspect-video bg-[#111] rounded-[2rem] overflow-hidden shadow-2xl border border-white/5 mb-8 group ring-1 ring-white/10">
                {currentWord.image_url ? (
                    <img 
                      src={currentWord.image_url} 
                      alt="Hint"
                      className={`w-full h-full object-cover transition-all duration-700 ${hintLevel < 2 ? 'blur-3xl saturate-0 scale-110' : 'blur-0'}`}
                    />
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-gray-700 bg-[#0d0d0d]">
                        <svg className="w-12 h-12 mb-2 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        <span className="text-[10px] font-mono uppercase tracking-[0.2em]">Visual Hint Pending</span>
                    </div>
                )}
                
                <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-80" />

                <div className="absolute inset-x-0 bottom-0 p-8 text-center">
                    {isRevealed && (
                        <div className="animate-in slide-in-from-bottom-2 duration-300">
                            <span className={`text-4xl font-black tracking-[0.2em] uppercase block mb-2 ${feedback === 'CORRECT' ? 'text-electric-green' : 'text-red-500'}`}>
                                {currentWord.text}
                            </span>
                            <div className="inline-block px-3 py-1 bg-white/10 backdrop-blur-md rounded-lg text-gray-400 font-mono text-xs border border-white/5">
                              {currentWord.phonetic || "/ ... /"}
                            </div>
                        </div>
                    )}
                    {hintLevel >= 2 && !isRevealed && (
                        <div className="animate-in fade-in duration-500">
                            <p className="text-xl text-gray-300 font-light italic leading-relaxed max-w-lg mx-auto">
                              "{currentWord.definition_en || "Keep listening to the audio hints..."}"
                            </p>
                        </div>
                    )}
                </div>

                <button 
                  onClick={() => playAudio(currentWord)}
                  className={`absolute top-6 right-6 p-4 bg-blue-500 text-black rounded-2xl hover:bg-blue-400 transition-all shadow-xl flex items-center gap-2 group/play ${isPlayingAudio ? 'animate-pulse scale-95' : ''}`}
                  title="Replay Audio"
                >
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                    <span className="font-headline text-xs tracking-widest hidden group-hover/play:inline">REPLAY</span>
                </button>
            </div>

            {/* Action Zone */}
            <div className="w-full max-w-4xl px-4 flex flex-col items-center">
                {/* Attempt Indicators */}
                {!isRevealed && feedback !== 'CORRECT' && (
                    <div className="flex gap-3 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        {[0, 1, 2].map((i) => (
                            <div 
                                key={i}
                                className={`w-10 h-1.5 rounded-full transition-all duration-500 ${
                                    i < (3 - currentAttempts)
                                        ? 'bg-electric-blue shadow-[0_0_10px_rgba(0,240,255,0.5)]'
                                        : 'bg-mid-charcoal'
                                }`}
                            />
                        ))}
                    </div>
                )}
                
                <div className={`w-full transition-all duration-500 ${feedback === 'CORRECT' ? 'scale-105' : ''}`}>
                    <LargeWordInput
                      value={isRevealed ? currentWord.text : inputValue}
                      onChange={(val) => {
                          if (!isRevealed) {
                              setInputValue(val);
                              if (feedback === 'WRONG') setFeedback('NONE');
                          }
                      }}
                      onEnter={checkAnswer}
                      disabled={feedback === 'CORRECT' || isRevealed}
                      status={feedback === 'CORRECT' ? 'correct' : feedback === 'WRONG' ? 'wrong' : 'idle'}
                      showWordBlocks={hintLevel >= 1}
                      targetWord={currentWord.text}
                  />
                </div>

                <div className="mt-8 flex items-center gap-6">
                    {isRevealed ? (
                        <button 
                          onClick={() => handleNext(0)}
                          className="px-12 py-4 bg-red-600 text-white rounded-[2rem] font-headline text-lg hover:bg-red-700 transition-all shadow-[0_10px_30px_rgba(220,38,38,0.3)] flex items-center gap-4 animate-in zoom-in duration-300 pointer-events-auto cursor-pointer"
                        >
                            <span>I'LL LEARN IT</span>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                        </button>
                    ) : feedback !== 'CORRECT' ? (
                      <>
                          <button 
                              onClick={handleHint}
                              disabled={hintLevel >= 2}
                              className="group flex flex-col items-center gap-2 transition-all disabled:opacity-20"
                          >
                              <div className="w-14 h-14 rounded-full border border-white/10 flex items-center justify-center group-hover:border-blue-500/50 group-hover:bg-blue-500/5 transition-all">
                                  <svg className="w-6 h-6 text-gray-500 group-hover:text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                              </div>
                              <span className="text-[10px] font-mono text-gray-600 group-hover:text-blue-500 tracking-widest uppercase">Add Hint</span>
                          </button>

                          <div className="h-8 w-[1px] bg-white/5" />
                          
                          <button 
                              onClick={checkAnswer}
                              className="group flex flex-col items-center gap-2 transition-all"
                          >
                               <div className="w-14 h-14 rounded-full border border-white/10 flex items-center justify-center group-hover:border-green-500/50 group-hover:bg-green-500/5 transition-all">
                                  <svg className="w-6 h-6 text-gray-500 group-hover:text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" /></svg>
                              </div>
                              <span className="text-[10px] font-mono text-gray-600 group-hover:text-green-500 tracking-widest uppercase">Check</span>
                          </button>

                          <div className="h-8 w-[1px] bg-white/5" />

                          <button 
                              onClick={handleReveal}
                              className="group flex flex-col items-center gap-2 transition-all"
                          >
                              <div className="w-14 h-14 rounded-full border border-white/10 flex items-center justify-center group-hover:border-red-500/50 group-hover:bg-red-500/5 transition-all">
                                  <svg className="w-6 h-6 text-gray-500 group-hover:text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                              </div>
                              <span className="text-[10px] font-mono text-gray-600 group-hover:text-red-500 tracking-widest uppercase">Reveal</span>
                          </button>
                      </>
                    ) : null}
                </div>
            </div>

            {/* History Cards Zone */}
            {historyItems.length > 0 && (
                <div className="w-full max-w-4xl px-4 mt-12 pt-8 border-t border-white/5">
                     <p className="text-[10px] font-mono text-gray-600 uppercase tracking-widest mb-4 flex items-center gap-2">
                         <span className="material-symbols-outlined text-sm">history</span>
                         Completed Words
                     </p>
                    <div className="flex flex-wrap gap-3 justify-center md:justify-start">
                        {historyItems.map((result) => {
                            const word = allWords.find(w => w.id === result.id);
                            if (!word) return null;
                            return <HistoryCard key={result.id} result={result} word={word} />;
                        })}
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default TestModeV2;
