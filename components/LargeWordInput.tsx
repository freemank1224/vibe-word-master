
import React, { useRef, useEffect, useState } from 'react';

interface LargeWordInputProps {
  value: string;
  onChange: (val: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  disabled?: boolean;
  hintOverlay?: string; // Partial word hint
  status?: 'idle' | 'correct' | 'wrong';
}

export const LargeWordInput: React.FC<LargeWordInputProps> = ({ 
  value, 
  onChange, 
  onEnter, 
  placeholder, 
  disabled,
  hintOverlay,
  status = 'idle'
}) => {
  const [inputWidth, setInputWidth] = useState('400px');
  const spanRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const MIN_WIDTH = 450; // Visual impact minimum width
  const PADDING = 80;

  // Adaptive width calculation: only grows if word exceeds MIN_WIDTH
  useEffect(() => {
    if (spanRef.current) {
      const measuredWidth = spanRef.current.offsetWidth;
      const calculated = measuredWidth + PADDING;
      setInputWidth(`${Math.max(MIN_WIDTH, calculated)}px`);
    }
  }, [value, placeholder]);

  // Robust focus management: Always keep the input focused
  const keepFocus = () => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus();
    }
  };

  useEffect(() => {
    // Initial focus
    keepFocus();

    // Re-focus after interactions elsewhere
    const handleGlobalClick = (e: MouseEvent) => {
      // If clicking outside the input, snap focus back immediately
      if (e.target !== inputRef.current && !disabled) {
        // Small delay to allow button click events (like "Submit" or "Verify") 
        // to process their own logic before focus is yanked back
        setTimeout(keepFocus, 50);
      }
    };

    window.addEventListener('mousedown', handleGlobalClick);
    return () => window.removeEventListener('mousedown', handleGlobalClick);
  }, [disabled]);

  // Ensure focus is regained when current word changes or disabled state flips
  useEffect(() => {
    if (!disabled) {
      keepFocus();
    }
  }, [disabled, value]);

  return (
    <div className="relative w-full flex justify-center items-center h-64 md:h-80 px-4 group">
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        .animate-shake {
          animation: shake 0.2s ease-in-out 0s 2;
        }
        .status-correct {
          color: #2EE67C !important;
          border-color: #2EE67C !important;
          filter: drop-shadow(0 0 15px rgba(46, 230, 124, 0.4));
        }
        .status-wrong {
          color: #ef4444 !important;
          border-color: #ef4444 !important;
          filter: drop-shadow(0 0 15px rgba(239, 68, 68, 0.4));
        }
      `}</style>
      {/* Hidden element to measure text width for adaptive resizing */}
      <span 
        ref={spanRef}
        className="invisible absolute font-serif text-6xl md:text-9xl tracking-widest whitespace-pre pointer-events-none"
        aria-hidden="true"
      >
        {value || placeholder || ''}
      </span>

      <div className="relative max-w-full flex justify-center h-full items-center">
        {hintOverlay && (
          <div 
            className="absolute inset-0 flex items-center justify-center pointer-events-none font-serif text-6xl md:text-9xl text-electric-blue/20 tracking-widest whitespace-pre"
            aria-hidden="true"
          >
            {hintOverlay}
          </div>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter?.();
            }
          }}
          placeholder={placeholder}
          readOnly={disabled}
          spellCheck="true"
          style={{ width: inputWidth, maxWidth: 'calc(100vw - 6rem)' }}
          className={`bg-transparent border-b-4 outline-none py-8 text-center font-serif text-6xl md:text-9xl tracking-widest transition-all placeholder:text-mid-charcoal/30 focus:ring-0 ${
            status === 'correct' 
              ? 'status-correct scale-105' 
              : status === 'wrong' 
              ? 'status-wrong animate-shake' 
              : 'border-mid-charcoal focus:border-electric-blue text-white'
          }`}
          autoFocus
        />
      </div>
    </div>
  );
};
