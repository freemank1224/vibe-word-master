
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WordEntry, InputSession } from '../types';
import { updateWordStatusV2 } from '../services/dataService';
import { fetchDictionaryData } from '../services/dictionaryService';
import { aiService } from '../services/ai';
import { playDing, playBuzzer } from '../utils/audioFeedback';
import { LargeWordInput } from './LargeWordInput';
import { Confetti } from './Confetti';

interface TestModeV2Props {
  allWords: WordEntry[];
  initialSessionIds: string[];
  initialWordIds?: string[];
  onComplete: (results: { id: string; correct: boolean }[]) => void;
  onCancel: () => void;
  onUpdateWord?: (id: string, updates: Partial<WordEntry>) => void;
}

const TestModeV2: React.FC<TestModeV2Props> = ({ 
  allWords, 
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
  const [hintLevel, setHintLevel] = useState(0); // 0: Audio only, 1: Burm Image, 2: Meaning
  const [isRevealed, setIsRevealed] = useState(false);
  const [startTime, setStartTime] = useState<number>(0);
  const [results, setResults] = useState<{ id: string; correct: boolean }[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [confettiConfig, setConfettiConfig] = useState<{title?: string, subtitle?: string, variant?: 'green' | 'blue' | 'purple', showParticles?: boolean}>({});
  const [streak, setStreak] = useState(0);
  const [isStarted, setIsStarted] = useState(false);

  // Loading States & Refs
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [isResourcesLoaded, setIsResourcesLoaded] = useState(false);
  const [missingResources, setMissingResources] = useState<{images: number, audio: number}>({ images: 0, audio: 0 });
  const resourceCacheRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const isMountedRef = useRef(true);

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

    const targetCount = Math.max(1, Math.round((availablePool.length * coverage) / 100));
    
    // Fisher-Yates Shuffle for true unbiased randomness
    const shuffled = [...availablePool];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    setQueue(shuffled.slice(0, targetCount));
  }, [availablePool, coverage, isStarted, isSelectionConfirmed]);

  useEffect(() => {
    // Cleanup audio on unmount
    return () => {
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
        
        // Parallel loading with concurrency limit could be better, but for <20 words, all-at-once is okay
        const promises = queue.map(async (word) => {
            if (!isMountedRef.current) return;
            try {
                // 1. Fetch Audio Data if missing
                let audioUrl = word.audio_url;
                if (!audioUrl) {
                    try {
                         // Quick check if we can get it
                        const data = await fetchDictionaryData(word.text);
                        if (data?.audioUrl) {
                            audioUrl = data.audioUrl;
                            word.audio_url = audioUrl; // Update local reference
                        } else {
                            missingAud++;
                        }
                    } catch (e) { 
                        missingAud++;
                    }
                }

                // 2. Preload Audio
                if (audioUrl) {
                    await new Promise<void>((resolve) => {
                        const audio = new Audio();
                        audio.preload = 'auto'; 
                        
                        const timeoutId = setTimeout(() => {
                           // If timeout, we resolve but it might be missing
                           resolve();
                        }, 8000); 
                        
                        audio.oncanplaythrough = () => {
                            clearTimeout(timeoutId);
                            resolve();
                        };
                        audio.onerror = () => {
                            clearTimeout(timeoutId);
                            missingAud++; // Mark as failed
                            resolve();
                        };
                        audio.src = audioUrl!;
                        resourceCacheRef.current.set(word.id, audio);
                    });
                } else {
                    // Audio missing
                    // We don't increment missingAud here again if we already did above
                    // But if it was originally null and fetch failed, it is missing.
                }

                // 3. Preload Image - NOW WITH AWAIT
                if (word.image_url) {
                    await new Promise<void>((resolve) => {
                         const img = new Image();
                         // Timeout for image
                         const timeoutId = setTimeout(() => {
                            // Timeout = effectively missing for user experience
                            // But we don't strictly count it as "error" unless we want to warn.
                            // Let's count it potentially.
                            resolve(); 
                         }, 5000);

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
        });

        await Promise.all(promises);
        
        if (isMountedRef.current) {
            setMissingResources({ images: missingImg, audio: missingAud });
            setIsResourcesLoaded(true);
        }
    };

    loadResources();

    return () => {
        // Cleanup cache on unmount or queue change
        resourceCacheRef.current.forEach(audio => {
            audio.pause();
            audio.src = "";
            audio.removeAttribute('src'); // Detach
            audio.load(); // Cancel download
        });
        resourceCacheRef.current.clear();
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
    // Stop any playing audio
    if (activeWordIdRef.current) {
        // Stop cached audio if playing
        const cached = resourceCacheRef.current.get(activeWordIdRef.current);
        if (cached) {
            cached.pause();
            cached.currentTime = 0;
        }
    }
    
    // Stop ad-hoc audio
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
    
    stopAudio();
    setIsPlayingAudio(true);
    
    try {
        // Try cached audio first
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


        // Fallback logic
        let audioUrl = word.audio_url;
        
        // If no audio url, try to get it (but don't block if we can use TTS)
        if (!audioUrl) {
           // We'll proceed with TTS fallback immediately or fetch logic
           // For responsiveness, maybe check if we have fetched data previously or fetch now
           const dictData = await fetchDictionaryData(word.text).catch(() => null);
           
           // Double check: if user moved away, abort
           if (activeWordIdRef.current !== word.id) return;

           if (dictData?.audioUrl) {
                audioUrl = dictData.audioUrl;
                // Update in background
                updateWordStatusV2(word.id, { 
                    correct: word.correct,
                    phonetic: dictData.phonetic, // ensure phonetic is updated
                    audio_url: dictData.audioUrl,
                    definition_en: dictData.definition_en
                });
           }
        }

        // Double check before playing
        if (activeWordIdRef.current !== word.id) return;

        if (audioUrl) {
            const audio = new Audio(audioUrl);
            currentAudioSourceRef.current = audio;
            audio.onended = () => { if(isMountedRef.current) setIsPlayingAudio(false); };
            try {
                await audio.play();
            } catch (err) {
                console.warn("Audio play failed, falling back to TTS", err);
                // If audio fails, we might still be active, let's try TTS
                if (activeWordIdRef.current !== word.id) return;
                // fall through to TTS logic
                throw new Error("Audio element failed");
            }
        } else {
            // Fallback to AI Service / TTS
            const audioResponse = await aiService.generateSpeech(word.text);
            
            // Double check: if user moved away, abort
            if (activeWordIdRef.current !== word.id) return;

            if (!audioResponse) throw new Error("No audio generated");

            if (typeof audioResponse === 'string') {
                const u = new SpeechSynthesisUtterance(audioResponse);
                u.onend = () => { if(isMountedRef.current) setIsPlayingAudio(false); };
                u.onerror = () => { if(isMountedRef.current) setIsPlayingAudio(false); };
                window.speechSynthesis.speak(u);
            } else {
                if (!audioCtxRef.current) {
                    audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                }
                const ctx = audioCtxRef.current;
                
                const source = ctx.createBufferSource();
                source.buffer = audioResponse as AudioBuffer;
                source.connect(ctx.destination);
                source.onended = () => { if(isMountedRef.current) setIsPlayingAudio(false); };
                source.start(0);
                currentAudioSourceRef.current = source;
            }
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
  };


  const handleNext = useCallback(async (success: boolean) => {
      // Clear any pending timeouts
      if (nextTimeoutRef.current) {
          clearTimeout(nextTimeoutRef.current);
          nextTimeoutRef.current = null;
      }

      // Check if we are done
      if (!currentWord) return;

      const wordStartTime = startTime; 
      
      // 1. Sync to Database - updateWordStatusV2 handles tested and last_tested internally
      const dbUpdates = {
          correct: success,
          error_count_increment: success ? 0 : 1,
          best_time_ms: success ? (Date.now() - wordStartTime) : undefined
      };

      try {
        await updateWordStatusV2(currentWord.id, dbUpdates);
      } catch (e) {
        console.error("Failed to sync word status to DB:", e);
      }

      // 2. Real-time Local Update (for Calendar/Library synchronization)
      if (onUpdateWord) {
          onUpdateWord(currentWord.id, {
              correct: success,
              tested: true,
              last_tested: Date.now(),
              error_count: (currentWord.error_count || 0) + (success ? 0 : 1)
          });
      }

      const newResults = [...results, { id: currentWord.id, correct: success }];
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
      }
  }, [currentIndex, queue, results, startTime, onUpdateWord, results, streak, currentWord]);

  const handleReveal = () => {
      setIsRevealed(true);
      setFeedback('WRONG');
      playBuzzer();
  };

  const checkAnswer = () => {
      if (isProcessing || !currentWord) return;
      
      // If revealed, assume user wants to move on (Next with 'WRONG')
      if (isRevealed) {
          handleNext(false);
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
          // Auto-advance
          nextTimeoutRef.current = setTimeout(() => handleNext(true), 1200);
      } else {
          setIsProcessing(false); // Ensure unlocked
          setFeedback('WRONG');
          playBuzzer();
      }
  };

  if (isFinished) {
      const correctCount = results.filter(r => r.correct).length;
      const score = Math.round((correctCount / queue.length) * 100);
      
      const getEmoji = (s: number) => {
          if (s === 100) return '🏆';
          if (s >= 80) return '🔥';
          if (s >= 60) return '⭐';
          if (s >= 40) return '💪';
          return '📚';
      };

      return (
        <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col items-center justify-center p-8 z-50 text-white animate-in fade-in duration-700">
          <Confetti showParticles={true} variant={score >= 80 ? 'purple' : 'blue'} />
          
          <div className="text-8xl mb-6 animate-bounce">
              {getEmoji(score)}
          </div>

          <h2 className="text-4xl font-headline mb-4 tracking-tighter uppercase">Test Complete!</h2>
          <div className={`text-7xl font-black mb-8 ${score >= 80 ? 'text-electric-green' : score >= 60 ? 'text-electric-blue' : 'text-orange-500'}`}>
            {score}%
          </div>
          <p className="text-gray-400 mb-8 font-mono">
            Correct: {correctCount} / {queue.length} | Time: {elapsedTime}s
          </p>
          <button 
            onClick={() => onComplete(results)}
            className="px-12 py-4 bg-white text-black rounded-2xl font-headline text-xl hover:bg-electric-blue hover:text-white transition-all transform hover:scale-105 active:scale-95 shadow-xl"
          >
            RESTORE SYSTEM
          </button>
        </div>
      );
  }

  if (!isStarted) {
    return (
        <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col items-center justify-center p-8 z-50 text-white">
            <div className="max-w-md w-full text-center">
                <div className="w-36 h-36 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-8 border border-white/10 overflow-hidden group">
                    <img 
                      src={`/monsterImages/M${new Date().getDay()}.png`} 
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
                            className={`h-full transition-all duration-300 ${!isSelectionConfirmed ? 'bg-gray-700' : isResourcesLoaded ? 'bg-green-500' : 'bg-blue-500'}`}
                            style={{ width: `${!isSelectionConfirmed ? 0 : (loadingProgress.current / Math.max(loadingProgress.total, 1)) * 100}%` }}
                         />
                    </div>
                    <div className="flex justify-between text-xs font-mono text-gray-500">
                      <span>{!isSelectionConfirmed ? 'IDLE' : isResourcesLoaded ? 'READY' : 'LOADING RESOURCES...'}</span>
                      <span>{!isSelectionConfirmed ? '0%' : Math.round((loadingProgress.current / Math.max(loadingProgress.total, 1)) * 100) + '%'}</span>
                    </div>

                    {isResourcesLoaded && missingResources.images > 0 && (
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
                        disabled={isSelectionConfirmed && !isResourcesLoaded}
                        className={`w-full px-8 py-4 text-black rounded-2xl font-headline text-xl transition-all transform duration-300
                            ${(!isSelectionConfirmed || isResourcesLoaded)
                                ? 'bg-blue-500 hover:bg-blue-400 hover:scale-[1.02] active:scale-95 shadow-[0_0_20px_rgba(59,130,246,0.3)] cursor-pointer' 
                                : 'bg-gray-800 text-gray-500 cursor-not-allowed opacity-50'}`}
                    >
                        {!isSelectionConfirmed 
                            ? 'PREPARE NEURAL LINK' 
                            : isResourcesLoaded 
                                ? (missingResources.images > 0 ? 'START ANYWAY' : 'START SESSION') 
                                : 'SYNCING...'}
                    </button>
                    <button 
                        onClick={onCancel}
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

  return (
    <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col z-50 text-white overflow-hidden">
      {showConfetti && <Confetti {...confettiConfig} />}
      
      {/* Top Progress Bar */}
      <div className="h-2 w-full bg-gray-900 border-b border-white/5">
        <div 
          className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500 ease-out shadow-[0_0_15px_rgba(59,130,246,0.5)]" 
          style={{ width: `${((currentIndex + 1) / queue.length) * 100}%` }}
        />
      </div>

      {/* Header */}
      <div className="p-6 flex justify-between items-center">
        <div className="flex items-center gap-4">
            <button onClick={onCancel} className="p-2 bg-white/5 hover:bg-white/10 rounded-xl text-gray-500 hover:text-white transition-all">
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

      {/* The Stage (Hint Area) */}
      <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="relative w-full max-w-2xl aspect-video bg-[#111] rounded-[2rem] overflow-hidden shadow-2xl border border-white/5 mb-8 group ring-1 ring-white/10">
              {currentWord.image_url ? (
                  <img 
                    src={currentWord.image_url} 
                    alt="Hint"
                    className={`w-full h-full object-cover transition-all duration-700 ${hintLevel === 0 ? 'blur-3xl saturate-0 scale-110' : hintLevel === 1 ? 'blur-xl' : 'blur-0'}`}
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
          <div className="w-full max-w-4xl px-4 flex flex-col items-center translate-y-[-2rem]">
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
                  />
              </div>

              <div className="mt-12 flex items-center gap-6">
                  {isRevealed ? (
                      <button 
                        onClick={() => handleNext(false)}
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
      </div>
    </div>
  );
};

export default TestModeV2;
