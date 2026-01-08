
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AppMode, WordEntry, InputSession, DayStats } from './types';
import { LargeWordInput } from './components/LargeWordInput';
import { CalendarView } from './components/CalendarView';
import { Confetti } from './components/Confetti';
import { generateImageHint, generateSpeech, extractWordFromImage } from './services/geminiService';
import { playDing, playBuzzer } from './utils/audioFeedback';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('DASHBOARD');
  const [words, setWords] = useState<WordEntry[]>([]);
  const [sessions, setSessions] = useState<InputSession[]>([]);
  const [targetCount, setTargetCount] = useState<number>(5);
  
  // Persistence
  useEffect(() => {
    const savedWords = localStorage.getItem('vocab_words');
    const savedSessions = localStorage.getItem('vocab_sessions');
    if (savedWords) setWords(JSON.parse(savedWords));
    if (savedSessions) setSessions(JSON.parse(savedSessions));
  }, []);

  useEffect(() => {
    localStorage.setItem('vocab_words', JSON.stringify(words));
    localStorage.setItem('vocab_sessions', JSON.stringify(sessions));
  }, [words, sessions]);

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

  const addSession = (sessionWords: string[]) => {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const newEntries: WordEntry[] = sessionWords.map(text => ({
      id: crypto.randomUUID(),
      text: text.toLowerCase().trim(),
      timestamp: now,
      sessionId,
      correct: false,
      tested: false
    }));
    
    setWords(prev => [...prev, ...newEntries]);
    setSessions(prev => [{
      id: sessionId,
      timestamp: now,
      wordCount: sessionWords.length,
      targetCount: sessionWords.length
    }, ...prev]);
  };

  const updateWordResult = (id: string, correct: boolean) => {
    setWords(prev => prev.map(w => w.id === id ? { ...w, correct, tested: true } : w));
  };

  return (
    <div className="min-h-screen flex flex-col font-body overflow-x-hidden">
      <header className="h-16 border-b border-mid-charcoal bg-dark-charcoal/80 backdrop-blur-md sticky top-0 z-50 px-6 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setMode('DASHBOARD')}>
          <span className="material-symbols-outlined text-electric-green text-3xl">bolt</span>
          <h1 className="font-headline text-2xl tracking-tighter text-electric-blue">VOCAB VIBE</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-text-dark">
            <span className="material-symbols-outlined text-sm">database</span>
            <span>LIBRARY: {words.length}</span>
          </div>
          <button className="p-2 text-text-light hover:text-electric-blue transition-colors">
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-[1400px] mx-auto w-full">
        {mode === 'DASHBOARD' && (
          <Dashboard 
            stats={getStats()} 
            sessions={sessions}
            words={words}
            onStartInput={() => setMode('INPUT')} 
            onStartTest={(sId) => {
                setMode('TEST');
                (window as any).selectedSessionId = sId;
            }} 
          />
        )}
        {mode === 'INPUT' && (
          <InputMode 
            targetCount={targetCount}
            setTargetCount={setTargetCount}
            onComplete={(newWords) => {
              addSession(newWords);
              setMode('DASHBOARD');
            }}
            onCancel={() => setMode('DASHBOARD')}
          />
        )}
        {mode === 'TEST' && (
          <TestMode 
            allWords={words}
            allSessions={sessions}
            initialSessionId={(window as any).selectedSessionId}
            onComplete={(results) => {
              results.forEach(res => updateWordResult(res.id, res.correct));
              setMode('DASHBOARD');
            }}
            onCancel={() => setMode('DASHBOARD')}
          />
        )}
      </main>

      <footer className="py-6 text-center text-text-dark text-sm border-t border-mid-charcoal bg-dark-charcoal">
        <p>&copy; 2024 VOCABVIBE MASTER - CHALLENGE ACCEPTED!</p>
      </footer>
    </div>
  );
};

// --- Dashboard Component ---
const Dashboard: React.FC<{ 
  stats: Record<string, DayStats>, 
  sessions: InputSession[],
  words: WordEntry[],
  onStartInput: () => void, 
  onStartTest: (sId: string) => void 
}> = ({ stats, sessions, words, onStartInput, onStartTest }) => {
  const [featuredImage, setFeaturedImage] = useState<string | null>(null);
  const [featuredWord, setFeaturedWord] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    const generateFeature = async () => {
      if (words.length > 0 && !featuredImage) {
        setIsGenerating(true);
        const randomWord = words[Math.floor(Math.random() * words.length)];
        setFeaturedWord(randomWord.text);
        const img = await generateImageHint(randomWord.text);
        setFeaturedImage(img);
        setIsGenerating(false);
      }
    };
    generateFeature();
  }, [words, featuredImage]);

  return (
    <div className="grid lg:grid-cols-12 gap-8 items-start animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="lg:col-span-8 flex flex-col gap-10">
        <div className="flex flex-col md:flex-row items-center gap-10">
          
          {/* AI Showcase Area */}
          <div className="w-full md:w-80 h-80 flex-shrink-0 relative group order-last md:order-first">
            <div className="absolute -inset-1 bg-gradient-to-r from-electric-blue to-electric-purple rounded-3xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative w-full h-full bg-light-charcoal rounded-3xl border border-mid-charcoal overflow-hidden flex flex-col items-center justify-center">
              {isGenerating ? (
                <div className="flex flex-col items-center gap-4 p-8 text-center">
                  <span className="material-symbols-outlined text-5xl text-electric-blue animate-spin">auto_awesome</span>
                  <p className="font-mono text-[10px] text-text-dark uppercase tracking-widest">Generating Visual Context...</p>
                </div>
              ) : featuredImage ? (
                <>
                  <img src={featuredImage} alt="Featured Word AI" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark-charcoal via-transparent to-transparent opacity-80"></div>
                  <div className="absolute bottom-4 left-4 right-4">
                    <p className="text-[10px] font-mono text-electric-blue uppercase tracking-[0.2em] mb-1">Featured Context</p>
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
            <p className="text-xl text-text-dark max-w-xl md:ml-auto">Master 10,000 words with AI-driven visuals and crystal clear audio feedback.</p>
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
          <button 
            className="flex-1 bg-electric-green text-charcoal font-headline text-3xl py-8 px-10 rounded-2xl hover:bg-electric-blue transition-all transform hover:-translate-y-1 hover:shadow-2xl flex items-center justify-center gap-4"
            onClick={() => sessions.length > 0 ? onStartTest(sessions[0].id) : onStartInput()}
          >
            <span className="material-symbols-outlined text-4xl">play_arrow</span>
            QUICK TEST
          </button>
        </div>

        <div className="space-y-4">
          <h3 className="font-headline text-2xl text-text-light tracking-widest border-b border-mid-charcoal pb-2">RECENT SESSIONS</h3>
          {sessions.length === 0 ? (
            <div className="p-8 border-2 border-dashed border-mid-charcoal rounded-2xl text-center text-text-dark">
              No sessions yet. Start by adding some words!
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {sessions.slice(0, 4).map(s => (
                <div key={s.id} className="bg-light-charcoal p-5 rounded-xl border border-mid-charcoal hover:border-electric-blue group transition-all">
                  <div className="flex justify-between items-start mb-3">
                    <span className="text-xs font-mono text-text-dark">{new Date(s.timestamp).toLocaleString()}</span>
                    <span className="bg-mid-charcoal text-electric-blue text-[10px] px-2 py-0.5 rounded font-bold uppercase">Batch</span>
                  </div>
                  <div className="flex justify-between items-end">
                    <div>
                      <p className="font-headline text-3xl text-white group-hover:text-electric-blue">{s.wordCount} WORDS</p>
                    </div>
                    <button 
                      onClick={() => onStartTest(s.id)}
                      className="p-2 bg-mid-charcoal rounded-lg text-electric-green hover:bg-electric-green hover:text-charcoal transition-colors"
                    >
                      <span className="material-symbols-outlined">quiz</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
                    {Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.correct, 0)} / {Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.total, 0)}
                </p>
              </div>
            </div>
            <div className="w-full bg-dark-charcoal rounded-full h-2">
                <div 
                    className="bg-electric-blue h-2 rounded-full shadow-[0_0_10px_rgba(0,240,255,0.5)]" 
                    style={{ width: `${(Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.correct, 0) / (Object.values(stats).reduce((acc: number, curr: DayStats) => acc + curr.total, 0) || 1)) * 100}%` }}
                ></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Input Mode Component ---
const InputMode: React.FC<{ 
  targetCount: number, 
  setTargetCount: (n: number) => void,
  onComplete: (words: string[]) => void,
  onCancel: () => void
}> = ({ targetCount, setTargetCount, onComplete, onCancel }) => {
  const [currentWords, setCurrentWords] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    if (inputValue.trim()) {
      const newWords = [...currentWords, inputValue.trim()];
      setCurrentWords(newWords);
      setInputValue('');
      if (newWords.length >= targetCount) {
        onComplete(newWords);
      }
    }
  };

  const handleVoiceInput = () => {
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
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      const extracted = await extractWordFromImage(base64);
      if (extracted) {
        setInputValue(extracted);
      } else {
        alert("Could not extract word from image.");
      }
      setIsProcessing(false);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-12 py-10 animate-in fade-in duration-500">
      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-4 bg-light-charcoal p-4 rounded-2xl border border-mid-charcoal">
          <label className="text-sm font-headline text-text-dark tracking-widest uppercase">Session Target:</label>
          <input 
            type="number" 
            value={targetCount} 
            onChange={(e) => setTargetCount(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-20 bg-dark-charcoal border-none rounded-lg text-electric-green font-mono font-bold text-center focus:ring-2 focus:ring-electric-green"
          />
        </div>
        
        <div className="w-full flex items-center justify-between text-xs font-mono text-text-dark">
          <span>PROGRESS</span>
          <span>{currentWords.length} / {targetCount}</span>
        </div>
        <div className="w-full h-2 bg-mid-charcoal rounded-full overflow-hidden">
          <div 
            className="h-full bg-electric-green transition-all duration-500" 
            style={{ width: `${(currentWords.length / targetCount) * 100}%` }}
          ></div>
        </div>
      </div>

      <div className="relative">
        <LargeWordInput 
          value={inputValue} 
          onChange={setInputValue} 
          onEnter={handleAdd}
          placeholder="TYPE WORD..."
          disabled={isProcessing}
        />
        {isProcessing && (
          <div className="absolute inset-0 bg-charcoal/50 backdrop-blur-sm flex items-center justify-center rounded-xl">
             <div className="flex items-center gap-3 text-electric-blue font-headline text-2xl animate-pulse">
                <span className="material-symbols-outlined animate-spin">sync</span>
                AI PROCESSING...
             </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-6">
        <button 
          onClick={handleVoiceInput}
          className="p-6 bg-mid-charcoal rounded-full text-white hover:text-electric-blue border-2 border-transparent hover:border-electric-blue transition-all group"
        >
          <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">mic</span>
        </button>
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="p-6 bg-mid-charcoal rounded-full text-white hover:text-electric-green border-2 border-transparent hover:border-electric-green transition-all group"
        >
          <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">photo_camera</span>
          <input type="file" ref={fileInputRef} onChange={handlePhotoInput} className="hidden" accept="image/*" />
        </button>
        <button 
          onClick={handleAdd}
          className="px-10 py-6 bg-electric-green text-charcoal font-headline text-3xl rounded-full hover:bg-electric-blue transition-all"
        >
          SUBMIT
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-12">
        {currentWords.map((w, i) => (
          <div key={i} className="bg-light-charcoal p-3 rounded-lg border border-mid-charcoal text-center font-mono text-electric-blue">
            {w}
          </div>
        ))}
      </div>
      
      <div className="text-center pt-8">
        <button onClick={onCancel} className="text-text-dark hover:text-white underline font-mono text-sm uppercase">Discard Session</button>
      </div>
    </div>
  );
};

// --- Test Mode Component ---
const TestMode: React.FC<{
  allWords: WordEntry[],
  allSessions: InputSession[],
  initialSessionId?: string,
  onComplete: (results: { id: string, correct: boolean }[]) => void,
  onCancel: () => void
}> = ({ allWords, allSessions, initialSessionId, onComplete, onCancel }) => {
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set(initialSessionId ? [initialSessionId] : []));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [results, setResults] = useState<{ id: string, correct: boolean }[]>([]);
  const [hintImage, setHintImage] = useState<string | null>(null);
  const [hintOverlay, setHintOverlay] = useState<string>('');
  const [isGeneratingHint, setIsGeneratingHint] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);

  // Derive current session pool words
  const poolWords = useMemo(() => {
    return allWords.filter(w => selectedSessionIds.has(w.sessionId));
  }, [allWords, selectedSessionIds]);

  const currentWord = poolWords[currentIndex];

  const playAudio = useCallback(async () => {
    if (!currentWord) return;
    const result = await generateSpeech(currentWord.text);
    if (!result) return;

    if (typeof result === 'string') {
      // Fallback: Browser native TTS
      const utterance = new SpeechSynthesisUtterance(result);
      utterance.lang = 'en-US';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    } else {
      // Primary: Gemini AudioBuffer
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const source = audioCtx.createBufferSource();
      source.buffer = result;
      source.connect(audioCtx.destination);
      source.start();
    }
  }, [currentWord]);

  useEffect(() => {
    if (currentWord) {
      playAudio();
      setHintImage(null);
      setHintOverlay('');
      setIsCorrect(null);
      setUserInput('');
    }
  }, [currentIndex, currentWord, playAudio]);

  const handleImageHint = async () => {
    if (!currentWord) return;
    setIsGeneratingHint(true);
    const img = await generateImageHint(currentWord.text);
    setHintImage(img);
    setIsGeneratingHint(false);
  };

  const handleLetterHint = () => {
    if (!currentWord) return;
    const text = currentWord.text;
    const revealedCount = Math.max(1, Math.floor(text.length / 3));
    let hint = text.split('').map(() => '_').join('');
    const indices = Array.from({ length: text.length }, (_, i) => i);
    for (let i = 0; i < revealedCount; i++) {
        const idxIdx = Math.floor(Math.random() * indices.length);
        const realIdx = indices.splice(idxIdx, 1)[0];
        const arr = hint.split('');
        arr[realIdx] = text[realIdx];
        hint = arr.join('');
    }
    setHintOverlay(hint);
  };

  const checkAnswer = () => {
    if (!currentWord) return;
    const correct = userInput.toLowerCase().trim() === currentWord.text;
    setIsCorrect(correct);
    
    // Audio Feedback
    if (correct) playDing();
    else playBuzzer();

    const newResults = [...results, { id: currentWord.id, correct }];
    setResults(newResults);
    
    setTimeout(() => {
      if (currentIndex + 1 < poolWords.length) {
        setCurrentIndex(prev => prev + 1);
      } else {
        // Test complete
        const isPerfect = newResults.every(r => r.correct);
        if (isPerfect) {
          setShowCelebration(true);
          setTimeout(() => onComplete(newResults), 5000);
        } else {
          onComplete(newResults);
        }
      }
    }, 1500);
  };

  const toggleSession = (id: string) => {
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCurrentIndex(0);
    setResults([]);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-12 py-10 animate-in fade-in duration-500">
      {showCelebration && <Confetti />}

      <div className="flex justify-between items-center bg-light-charcoal p-4 rounded-xl border border-mid-charcoal shadow-lg">
        <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-electric-blue">quiz</span>
            <span className="font-headline text-2xl text-electric-blue tracking-widest uppercase">Testing Mode</span>
        </div>
        <div className="font-mono text-electric-green font-bold text-lg">
          {poolWords.length > 0 ? `${currentIndex + 1} / ${poolWords.length}` : '0 / 0'}
        </div>
      </div>

      {poolWords.length > 0 ? (
        <>
          <div className="flex flex-col items-center gap-8">
            <div className="flex gap-4">
              <button 
                onClick={playAudio}
                className="p-4 bg-mid-charcoal rounded-xl text-white hover:text-electric-blue hover:bg-mid-charcoal/80 transition-all border border-mid-charcoal group"
              >
                <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">volume_up</span>
                <span className="block text-[10px] font-mono mt-1 uppercase opacity-60">Repeat</span>
              </button>
              <button 
                onClick={handleImageHint}
                disabled={isGeneratingHint}
                className="p-4 bg-mid-charcoal rounded-xl text-white hover:text-electric-green hover:bg-mid-charcoal/80 transition-all border border-mid-charcoal disabled:opacity-50 group"
              >
                <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">image</span>
                <span className="block text-[10px] font-mono mt-1 uppercase opacity-60">Visual</span>
              </button>
              <button 
                onClick={handleLetterHint}
                className="p-4 bg-mid-charcoal rounded-xl text-white hover:text-electric-purple hover:bg-mid-charcoal/80 transition-all border border-mid-charcoal group"
              >
                <span className="material-symbols-outlined text-4xl group-active:scale-90 transition-transform">spellcheck</span>
                <span className="block text-[10px] font-mono mt-1 uppercase opacity-60">Letters</span>
              </button>
            </div>

            {hintImage && (
              <div className="w-full md:w-[600px] h-64 rounded-2xl overflow-hidden border-4 border-electric-green shadow-2xl animate-in zoom-in-75 duration-300">
                <img src={hintImage} alt="AI Hint" className="w-full h-full object-cover" />
              </div>
            )}
            {isGeneratingHint && (
               <div className="w-full md:w-[600px] h-64 rounded-2xl border-4 border-dashed border-electric-blue flex flex-col items-center justify-center gap-4 animate-pulse bg-dark-charcoal/50">
                  <span className="material-symbols-outlined text-4xl animate-spin text-electric-blue">auto_awesome</span>
                  <p className="font-headline text-lg text-electric-blue uppercase">Generating Contextual Visual...</p>
               </div>
            )}
          </div>

          <div className="relative">
            <LargeWordInput 
              value={userInput} 
              onChange={setUserInput} 
              onEnter={checkAnswer}
              placeholder="SPELL IT..."
              hintOverlay={hintOverlay}
              disabled={isCorrect !== null}
            />
            {isCorrect === true && (
              <div className="absolute inset-0 flex items-center justify-center bg-electric-green/10 rounded-xl pointer-events-none border-4 border-electric-green animate-in fade-in zoom-in duration-300">
                <span className="material-symbols-outlined text-electric-green text-9xl drop-shadow-[0_0_20px_rgba(46,230,124,0.5)]">check_circle</span>
              </div>
            )}
            {isCorrect === false && (
              <div className="absolute inset-0 flex items-center justify-center bg-red-500/10 rounded-xl pointer-events-none border-4 border-red-500 animate-in shake duration-300">
                <div className="text-center">
                    <span className="material-symbols-outlined text-red-500 text-9xl drop-shadow-[0_0_20px_rgba(239,68,68,0.5)]">cancel</span>
                    <p className="font-serif text-4xl text-red-500 font-bold tracking-widest bg-dark-charcoal/80 px-4 py-2 rounded-lg mt-4">{currentWord?.text}</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-center">
             <button 
                onClick={checkAnswer}
                disabled={isCorrect !== null}
                className="px-16 py-6 bg-electric-blue text-charcoal font-headline text-4xl rounded-full hover:bg-white hover:scale-105 transition-all disabled:opacity-50 shadow-[0_0_20px_rgba(0,240,255,0.3)]"
             >
                VERIFY
             </button>
          </div>
        </>
      ) : (
        <div className="text-center p-20 border-2 border-dashed border-mid-charcoal rounded-3xl bg-light-charcoal/30">
            <span className="material-symbols-outlined text-8xl text-text-dark mb-4">folder_open</span>
            <p className="text-2xl font-headline text-text-dark uppercase tracking-widest">No Batches Selected</p>
            <p className="text-text-dark mt-2">Choose one or more sessions below to begin testing.</p>
        </div>
      )}

      <div className="text-center">
        <button onClick={onCancel} className="text-text-dark hover:text-white underline font-mono text-sm uppercase tracking-tighter">Abort Test & Exit</button>
      </div>

      <div className="mt-16 pt-10 border-t border-dashed border-mid-charcoal/50">
          <div className="flex items-center gap-3 mb-6">
              <span className="material-symbols-outlined text-text-dark">inventory_2</span>
              <h4 className="font-headline text-2xl text-text-dark tracking-widest uppercase">Select Vocabulary Pool (Batches)</h4>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {allSessions.map(session => (
                  <button 
                      key={session.id}
                      onClick={() => toggleSession(session.id)}
                      className={`relative overflow-hidden p-5 rounded-2xl border-2 transition-all text-left group flex flex-col justify-between h-32 ${
                          selectedSessionIds.has(session.id) 
                          ? 'bg-electric-blue/10 border-electric-blue shadow-[0_0_15px_rgba(0,240,255,0.1)]' 
                          : 'bg-light-charcoal border-mid-charcoal hover:border-text-dark'
                      }`}
                  >
                      <div className="flex justify-between items-start">
                          <span className={`material-symbols-outlined text-2xl ${selectedSessionIds.has(session.id) ? 'text-electric-blue' : 'text-text-dark'}`}>
                              {selectedSessionIds.has(session.id) ? 'check_box' : 'check_box_outline_blank'}
                          </span>
                          <span className="text-[10px] font-mono text-text-dark bg-dark-charcoal/50 px-2 py-0.5 rounded">
                              {new Date(session.timestamp).toLocaleDateString()}
                          </span>
                      </div>
                      <div>
                          <p className={`font-headline text-2xl ${selectedSessionIds.has(session.id) ? 'text-white' : 'text-text-dark'}`}>{session.wordCount} WORDS</p>
                          <p className="text-[10px] font-mono text-text-dark uppercase opacity-60">ID: ...{session.id.slice(-6)}</p>
                      </div>
                      
                      {selectedSessionIds.has(session.id) && (
                          <div className="absolute bottom-0 left-0 right-0 h-1 bg-electric-blue"></div>
                      )}
                  </button>
              ))}
          </div>
          <div className="mt-4 text-[10px] font-mono text-text-dark uppercase tracking-widest text-center opacity-50">
              Pick multiple batches to combine words into a single intensive test session.
          </div>
      </div>
    </div>
  );
};

export default App;
