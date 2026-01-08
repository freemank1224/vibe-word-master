
import React from 'react';

export const Confetti: React.FC = () => {
  const particles = Array.from({ length: 50 });
  const colors = ['#00F0FF', '#2EE67C', '#BB00FF', '#FFEB3B', '#FF5722'];

  return (
    <div className="fixed inset-0 pointer-events-none z-[100] overflow-hidden">
      {particles.map((_, i) => {
        const color = colors[i % colors.length];
        const left = Math.random() * 100;
        const delay = Math.random() * 3;
        const duration = 2 + Math.random() * 3;
        const size = 8 + Math.random() * 12;
        const rotation = Math.random() * 360;

        return (
          <div
            key={i}
            className="absolute top-[-20px] animate-confetti-fall"
            style={{
              left: `${left}%`,
              backgroundColor: color,
              width: `${size}px`,
              height: `${size * 0.4}px`,
              borderRadius: '2px',
              transform: `rotate(${rotation}deg)`,
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
            }}
          />
        );
      })}
      <style>{`
        @keyframes confetti-fall {
          0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(110vh) rotate(720deg);
            opacity: 0;
          }
        }
        .animate-confetti-fall {
          animation-name: confetti-fall;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
      `}</style>
      
      {/* Central "Perfect Score" Glow */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center animate-in zoom-in fade-in duration-1000">
           <h1 className="font-headline text-8xl md:text-9xl text-electric-green drop-shadow-[0_0_30px_rgba(46,230,124,0.8)] tracking-tighter">PERFECT!</h1>
           <p className="font-serif text-3xl text-white italic mt-4 opacity-80">You've mastered this batch.</p>
        </div>
      </div>
    </div>
  );
};
