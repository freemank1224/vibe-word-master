import React, { useState, useEffect } from 'react';
import { LargeWordInput } from './LargeWordInput';
import { Confetti } from './Confetti';

interface LandingPageProps {
  onStart: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onStart }) => {
  const [demoWord, setDemoWord] = useState('');
  const [demoStatus, setDemoStatus] = useState<'idle' | 'correct' | 'wrong'>('idle');
  const [showConfetti, setShowConfetti] = useState(false);

  useEffect(() => {
    let mounted = true;
    let timeoutId: NodeJS.Timeout;

    const runSequence = async () => {
      if (!mounted) return;

      while (mounted) {
        // Reset
        setDemoWord('');
        setDemoStatus('idle');
        setShowConfetti(false);
        await new Promise(r => timeoutId = setTimeout(r, 1000));

        // Type "VIBE"
        const word1 = "VIBE";
        for (let i = 0; i <= word1.length; i++) {
          if (!mounted) return;
          setDemoWord(word1.slice(0, i));
          await new Promise(r => timeoutId = setTimeout(r, 200));
        }

        // Simulate Check - Correct
        await new Promise(r => timeoutId = setTimeout(r, 500));
        if (!mounted) return;
        setDemoStatus('correct');
        setShowConfetti(true);
        
        // Hold success state
        await new Promise(r => timeoutId = setTimeout(r, 2000));
        if (!mounted) return;
        setShowConfetti(false);
        setDemoWord('');
        setDemoStatus('idle');

        // Pause
        await new Promise(r => timeoutId = setTimeout(r, 800));

        // Type "FAIL"
        const word2 = "OOPS";
        for (let i = 0; i <= word2.length; i++) {
          if (!mounted) return;
          setDemoWord(word2.slice(0, i));
          await new Promise(r => timeoutId = setTimeout(r, 200));
        }

        // Simulate Check - Wrong
        await new Promise(r => timeoutId = setTimeout(r, 500));
        if (!mounted) return;
        setDemoStatus('wrong');
        
        // Hold wrong state
        await new Promise(r => timeoutId = setTimeout(r, 1500));
      }
    };

    runSequence();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, []);

  return (
    <div className="min-h-screen bg-charcoal text-white flex flex-col items-center justify-center relative overflow-hidden">
        {/* Background Decorations */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-electric-purple/20 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-electric-blue/20 blur-[120px] rounded-full pointer-events-none" />

        <div className="w-full max-w-5xl px-6 relative z-10 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            
            {/* Left Content */}
            <div className="space-y-8 text-center md:text-left">
                <div className="inline-block px-4 py-1.5 rounded-full border border-electric-blue/30 bg-electric-blue/10 text-electric-blue font-mono text-sm tracking-wider mb-2 animate-pulse">
                    VOCAB MASTER V2.0
                </div>
                
                <h1 className="font-headline text-6xl md:text-8xl tracking-wide leading-none bg-gradient-to-br from-white via-gray-200 to-gray-500 bg-clip-text text-transparent drop-shadow-lg">
                    LEVEL UP <br/>
                    <span className="text-electric-blue drop-shadow-[0_0_15px_rgba(0,240,255,0.5)]">YOUR VIBE</span>
                </h1>
                
                <p className="font-body text-gray-400 text-lg md:text-xl max-w-md mx-auto md:mx-0 leading-relaxed">
                    Master vocabulary with style. Collect monsters, earn badges, and turn your daily learning into an addictive cyberpunk adventure.
                </p>

                <div className="pt-4">
                    <button 
                        onClick={onStart}
                        className="group relative px-8 py-4 bg-gradient-to-r from-electric-blue to-electric-purple rounded-xl font-headline text-2xl tracking-widest text-white shadow-[0_0_20px_rgba(0,240,255,0.3)] hover:shadow-[0_0_40px_rgba(187,0,255,0.5)] transition-all duration-300 transform hover:scale-105 active:scale-95"
                    >
                        <span className="relative z-10 flex items-center gap-3">
                            START NOW
                            <span className="material-symbols-outlined text-3xl group-hover:translate-x-1 transition-transform">arrow_forward</span>
                        </span>
                        <div className="absolute inset-0 bg-white/20 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                    </button>
                    <p className="mt-4 text-sm text-gray-500 font-mono">
                        Create account or Login to sync progress
                    </p>
                </div>
            </div>

            {/* Right Content - Visual Demo */}
            <div className="relative">
                 {/* Mascot Floating */}
                <div className="absolute -top-24 -right-12 w-48 h-48 md:w-64 md:h-64 z-20 animate-bounce" style={{ animationDuration: '3s' }}>
                    <img 
                        src="/monsterImages/M3.png" 
                        alt="Mascot" 
                        className="w-full h-full object-contain drop-shadow-[0_0_25px_rgba(46,230,124,0.4)]"
                    />
                </div>

                {/* Mock Phone/App Interface */}
                <div className="relative bg-light-charcoal/80 backdrop-blur-xl border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl transform rotate-[-2deg] hover:rotate-0 transition-transform duration-500">
                    <div className="mb-6 flex justify-between items-center opacity-50">
                        <div className="w-12 h-12 rounded-full bg-mid-charcoal animate-pulse" />
                        <div className="h-4 w-24 bg-mid-charcoal rounded animate-pulse" />
                    </div>

                    <div className="space-y-6">
                        <div className="text-center space-y-2">
                             <div className="text-electric-blue font-mono text-sm">CHALLENGE MODE</div>
                             <div className="font-headline text-3xl text-white">TYPE THE WORD</div>
                        </div>

                        <div className="pointer-events-none">
                            <LargeWordInput 
                                value={demoWord}
                                onChange={() => {}}
                                status={demoStatus}
                                placeholder="TYPE HERE..."
                            />
                        </div>

                        <div className="flex justify-center gap-2 pt-4">
                             <div className={`h-2 w-2 rounded-full transition-colors duration-300 ${demoStatus === 'correct' ? 'bg-electric-green' : 'bg-mid-charcoal'}`} />
                             <div className={`h-2 w-2 rounded-full transition-colors duration-300 ${demoStatus === 'wrong' ? 'bg-red-500' : 'bg-mid-charcoal'}`} />
                        </div>
                    </div>

                     {/* Confetti Overlay for Demo */}
                    {showConfetti && (
                        <div className="absolute inset-0 overflow-hidden rounded-3xl pointer-events-none z-30">
                            <Confetti showParticles={true} variant="blue" />
                        </div>
                    )}
                </div>
                
                {/* Decorative Elements around phone */}
                <div className="absolute -bottom-12 -left-12 text-electric-purple/20 font-headline text-9xl -z-10 select-none">
                    VIBE
                </div>
            </div>
        </div>

        {/* Footer */}
        <div className="absolute bottom-6 w-full text-center text-white/20 font-mono text-xs">
            © 2026 VOCAB MONSTER INC. ALL RIGHTS RESERVED.
        </div>
    </div>
  );
};
