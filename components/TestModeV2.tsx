
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WordEntry, InputSession } from '../types';
import { updateWordStatusV2, generateSRSQueue } from '../services/dataService';
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
    let baseWordIds: string[] = [];
    if (initialWordIds && initialWordIds.length > 0) {
      baseWordIds = initialWordIds;
    } else if (initialSessionIds.length > 0) {
      baseWordIds = allWords
        .filter(w => initialSessionIds.includes(w.sessionId))
        .map(w => w.id);
    }

    if (baseWordIds.length > 0) {
        const srsQueue = generateSRSQueue(allWords, baseWordIds, Math.max(baseWordIds.length, 10));
        setQueue(srsQueue);
    }
    setStartTime(Date.now());

    // Cleanup audio on unmount
    return () => {
        activeWordIdRef.current = null; // Invalidate any pending audio
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
  }, [initialSessionIds, initialWordIds, allWords]);

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

  const playAudio = useCallback(async (word: WordEntry) => {
    // 1. Mark this word as the intended target for audio
    activeWordIdRef.current = word.id;
    
    stopAudio();
    setIsPlayingAudio(true);
    
    try {
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
            audio.onended = () => setIsPlayingAudio(false);
            try {
                await audio.play();
            } catch (err) {
                console.warn("Audio play failed, falling back to TTS", err);
                // If audio fails, we might still be active, let's try TTS
                if (activeWordIdRef.current !== word.id) return;
                // fall through to TTS logic? Or throw to trigger catch? 
                // Let's just throw to go to catch block but catch block ends function.
                // We should handle fallback here explicitly or restructure.
                // Simpler: Set audioUrl to null and let logic proceed? No, it's if/else.
                // Refactoring slightly for robustness:
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
                u.onend = () => setIsPlayingAudio(false);
                u.onerror = () => setIsPlayingAudio(false);
                window.speechSynthesis.speak(u);
            } else {
                if (!audioCtxRef.current) {
                    audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                }
                const ctx = audioCtxRef.current;
                
                const source = ctx.createBufferSource();
                source.buffer = audioResponse as AudioBuffer;
                source.connect(ctx.destination);
                source.onended = () => setIsPlayingAudio(false);
                source.start(0);
                currentAudioSourceRef.current = source;
            }
        }
    } catch (e) {
        console.error("Audio playback error", e);
        // Only reset if we are still the active word
        if (activeWordIdRef.current === word.id) {
            setIsPlayingAudio(false);
        }
    }
  }, [stopAudio]);

  useEffect(() => {
    // Auto-play audio when word changes
    if (currentWord && !isFinished && !isRevealed && feedback === 'NONE' && isStarted) {
        // Sync active ID immediately
        activeWordIdRef.current = currentWord.id;
        
        // Small delay to ensure UI transition is smooth
        const t = setTimeout(() => {
            if (activeWordIdRef.current === currentWord.id) {
                playAudio(currentWord);
            }
        }, 300);
        return () => clearTimeout(t);
    }
  }, [currentIndex, isFinished, isStarted, playAudio, currentWord]); 

  const handleHint = () => {
      setHintLevel(prev => Math.min(prev + 1, 2));
  };


  const handleNext = useCallback((success: boolean) => {
      // Clear any pending timeouts
      if (nextTimeoutRef.current) {
          clearTimeout(nextTimeoutRef.current);
          nextTimeoutRef.current = null;
      }

      // Check if we are done
      if (!currentWord) return;

      const wordStartTime = startTime; 
      
      const updates = {
          correct: success,
          error_count_increment: success ? 0 : 1,
          best_time_ms: success ? (Date.now() - wordStartTime) : undefined,
          tested: true,
          last_tested: Date.now()
      };

      // 1. Sync to Database
      updateWordStatusV2(currentWord.id, updates);

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
                title: "PERFECT!",
                subtitle: `You've mastered ${queue.length} words.`,
                variant: 'green',
                showParticles: true
            });
            setShowConfetti(true);
          } else if (queue.length >= 20) {
            // Milestone 1/3
            if (progress >= 0.33 && !milestonesReached.current.has('1/3')) {
                milestonesReached.current.add('1/3');
                setConfettiConfig({
                    title: "KEEP IT UP!",
                    subtitle: "1/3 done! Keep the momentum.",
                    variant: 'blue',
                    showParticles: false
                });
                setShowConfetti(true);
            } 
            // Milestone 2/3
            else if (progress >= 0.66 && !milestonesReached.current.has('2/3')) {
                milestonesReached.current.add('2/3');
                setConfettiConfig({
                    title: "ALMOST THERE!",
                    subtitle: "2/3 complete. Stay focused.",
                    variant: 'purple',
                    showParticles: false
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
      return (
        <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col items-center justify-center p-8 z-50 text-white">
          <h2 className="text-4xl font-bold mb-4">Test Complete!</h2>
          <div className="text-6xl font-black text-blue-500 mb-8">
            {Math.round((correctCount / queue.length) * 100)}%
          </div>
          <p className="text-gray-400 mb-8">
            Correct: {correctCount} / {queue.length} | Time: {elapsedTime}s
          </p>
          <button 
            onClick={() => onComplete(results)}
            className="px-8 py-3 bg-white text-black rounded-full font-bold hover:bg-gray-200 transition-colors"
          >
            FINISH
          </button>
        </div>
      );
  }

  if (!currentWord) return null;

  if (!isStarted) {
    return (
        <div className="fixed inset-0 bg-[#0a0a0a] flex flex-col items-center justify-center p-8 z-50 text-white">
            <div className="max-w-md w-full text-center">
                <div className="w-24 h-24 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-8 border border-blue-500/20">
                    <svg className="w-12 h-12 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <h2 className="text-4xl font-headline mb-4 tracking-tight uppercase">Ready to Vibe?</h2>
                <p className="text-gray-400 mb-10 font-body leading-relaxed">
                    You're about to test <span className="text-white font-bold">{queue.length} words</span>. 
                    Listen carefully to the audio and spell the word correctly.
                </p>
                <div className="flex flex-col gap-4">
                    <button 
                        onClick={() => {
                            setIsStarted(true);
                            setStartTime(Date.now());
                        }}
                        className="w-full px-8 py-4 bg-blue-500 text-black rounded-2xl font-headline text-xl hover:bg-blue-400 transition-all transform hover:scale-[1.02] active:scale-95 shadow-[0_0_20px_rgba(59,130,246,0.3)]"
                    >
                        START SESSION
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
                          <span className="text-4xl font-black tracking-[0.2em] uppercase text-blue-500 block mb-2">
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
