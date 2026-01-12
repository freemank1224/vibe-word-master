
import React from 'react';

interface ConfettiProps {
  title?: string;
  subtitle?: string;
  variant?: 'green' | 'blue' | 'purple';
  showParticles?: boolean;
}

export const Confetti: React.FC<ConfettiProps> = ({ 
  title = "PERFECT!", 
  subtitle = "You've mastered this batch.",
  variant = 'green',
  showParticles = true
}) => {
  const particles = Array.from({ length: 50 });
  const colors = variant === 'green' 
    ? ['#00F0FF', '#2EE67C', '#BB00FF', '#FFEB3B', '#FF5722']
    : variant === 'blue'
    ? ['#3B82F6', '#60A5FA', '#93C5FD', '#FFFFFF', '#1D4ED8']
    : ['#A855F7', '#C084FC', '#E9D5FF', '#FFFFFF', '#7E22CE'];

  const dropShadowColor = variant === 'green' 
    ? 'rgba(46,230,124,0.8)' 
    : variant === 'blue' 
    ? 'rgba(59,130,246,0.8)'
    : 'rgba(168,85,247,0.8)';
    
  const titleColor = variant === 'green'
    ? 'text-electric-green'
    : variant === 'blue'
    ? 'text-blue-400'
    : 'text-purple-400';

  return (
    <div className="fixed inset-0 pointer-events-none z-[100] overflow-hidden">
      {showParticles && particles.map((_, i) => {
        const color = colors[i % colors.length];
        const left = Math.random() * 100;
        const delay = Math.random() * 2;
        const duration = 1.5 + Math.random() * 2;
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
          animation-iteration-count: 2;
        }
      `}</style>
      
      {/* Central Message Glow */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
        <div className="text-center animate-in zoom-in fade-in duration-700">
           <h1 className={`font-headline text-8xl md:text-9xl ${titleColor} tracking-tighter`} style={{ filter: `drop-shadow(0 0 30px ${dropShadowColor})` }}>
             {title}
           </h1>
           <p className="font-serif text-3xl text-white italic mt-4 opacity-80">{subtitle}</p>
        </div>
      </div>
    </div>
  );
};
