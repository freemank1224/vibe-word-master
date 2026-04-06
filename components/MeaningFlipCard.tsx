import React, { useState } from 'react';

interface MeaningFlipCardProps {
  front: React.ReactNode;
  meaning?: string | null;
  className?: string;
  frontClassName?: string;
  backClassName?: string;
  disabled?: boolean;
}

const faceStyle: React.CSSProperties = {
  backfaceVisibility: 'hidden',
  WebkitBackfaceVisibility: 'hidden',
};

export const MeaningFlipCard: React.FC<MeaningFlipCardProps> = ({
  front,
  meaning,
  className = '',
  frontClassName = '',
  backClassName = '',
  disabled = false,
}) => {
  const [isFlipped, setIsFlipped] = useState(false);
  const displayMeaning = meaning?.trim() || '暂无中文释义';

  const toggleFlip = () => {
    if (disabled) return;
    setIsFlipped(prev => !prev);
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={isFlipped}
      onClick={toggleFlip}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleFlip();
        }
      }}
      className={`relative cursor-pointer outline-none [perspective:1200px] ${disabled ? 'cursor-default' : ''} ${className}`.trim()}
    >
      <div
        className="relative h-full w-full transition-transform duration-500"
        style={{
          transformStyle: 'preserve-3d',
          transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        <div className={`absolute inset-0 ${frontClassName}`.trim()} style={faceStyle}>
          {front}
        </div>
        <div
          className={`absolute inset-0 ${backClassName}`.trim()}
          style={{
            ...faceStyle,
            transform: 'rotateY(180deg)',
          }}
        >
          <div className="flex h-full flex-col justify-between rounded-inherit">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-gray-500">中文释义</p>
              <p className="mt-3 text-sm leading-relaxed text-white sm:text-base">{displayMeaning}</p>
            </div>
            <p className="mt-4 text-[10px] font-mono uppercase tracking-[0.2em] text-gray-600">点击切回正面</p>
          </div>
        </div>
      </div>
    </div>
  );
};
