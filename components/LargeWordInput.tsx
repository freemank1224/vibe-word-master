
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import './LargeWordInput.css';

interface LargeWordInputProps {
  value: string;
  onChange: (val: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  disabled?: boolean;
  hintOverlay?: string; // Partial word hint
  status?: 'idle' | 'correct' | 'wrong';
  showWordBlocks?: boolean;
  targetWord?: string;
  theme?: 'default' | 'review';
  maxWidth?: string;
  fitToContent?: boolean;
  showProcessingOverlay?: boolean;
  processingLabel?: string;
  processingStep?: number;
  processingTotalSteps?: number;
  /** Compact layout for an embedded game panel; the standard test layout stays unchanged. */
  variant?: 'default' | 'embedded';
  inputRef?: React.Ref<HTMLInputElement>;
  id?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  autoFocus?: boolean;
  /** When false, the parent owns focus (for games with pause and replay controls). */
  manageFocus?: boolean;
  onCompositionStart?: React.CompositionEventHandler<HTMLInputElement>;
  onCompositionEnd?: React.CompositionEventHandler<HTMLInputElement>;
}

export const LargeWordInput: React.FC<LargeWordInputProps> = ({ 
  value, 
  onChange, 
  onEnter, 
  placeholder, 
  disabled,
  hintOverlay,
  status = 'idle',
  showWordBlocks = false,
  targetWord = '',
  theme = 'default',
  maxWidth = 'calc(100vw - 6rem)',
  fitToContent = false,
  showProcessingOverlay = false,
  processingLabel,
  processingStep,
  processingTotalSteps,
  variant = 'default',
  inputRef: externalInputRef,
  id,
  ariaLabel,
  ariaDescribedBy,
  ariaInvalid,
  autoFocus = true,
  manageFocus = true,
  onCompositionStart,
  onCompositionEnd
}) => {
  const { isZh } = useLanguage();
  const [inputWidth, setInputWidth] = useState('400px');
  const spanRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [selectionPosition, setSelectionPosition] = useState<number | null>(null);
  const embedded = variant === 'embedded';
  const assignInputRef = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof externalInputRef === 'function') externalInputRef(node);
    else if (externalInputRef) externalInputRef.current = node;
  }, [externalInputRef]);
  const targetLetters = targetWord.split('');
  const enteredLetters = (embedded ? value.normalize('NFKC').trim() : value).split('');
  const leadingWhitespace = embedded ? value.length - value.trimStart().length : 0;
  const currentPosition = Math.max(0, Math.min(enteredLetters.length, (selectionPosition ?? value.length) - leadingWhitespace));
  const positionCount = embedded ? Math.max(targetLetters.length, Math.min(enteredLetters.length, targetLetters.length + 4)) : targetLetters.length;


  const MIN_WIDTH = 450; // Visual impact minimum width
  const PADDING = 80;

  // Adaptive width calculation: only grows if word exceeds MIN_WIDTH
  useEffect(() => {
    if (!embedded && spanRef.current) {
      const measuredWidth = spanRef.current.offsetWidth;
      const calculated = measuredWidth + PADDING;
      setInputWidth(`${Math.max(MIN_WIDTH, calculated)}px`);
    }
  }, [value, placeholder, embedded]);

  // Robust focus management: Always keep the input focused
  const keepFocus = () => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus();
    }
  };

  useEffect(() => {
    if (!manageFocus) return;
    // Standard test mode retains its existing focus behavior.
    if (autoFocus) keepFocus();

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
  }, [disabled, manageFocus, autoFocus]);

  // Ensure focus is regained when current word changes or disabled state flips
  useEffect(() => {
    if (manageFocus && autoFocus && !disabled) {
      keepFocus();
    }
  }, [disabled, value, manageFocus, autoFocus]);

  return (
    <div className={embedded ? 'lwi-embedded' : `relative flex justify-center items-center h-64 md:h-80 px-4 group transition-[width,max-width] duration-300 ease-out ${fitToContent ? 'w-fit max-w-full mx-auto' : 'w-full'}`} data-input-variant={variant} data-word-length={showWordBlocks ? targetLetters.length : undefined}>
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
        .theme-review-idle {
          color: #fca5a5 !important;
          border-color: rgba(239, 68, 68, 0.75) !important;
          filter: drop-shadow(0 0 12px rgba(239, 68, 68, 0.18));
        }
        .theme-review-idle::placeholder {
          color: rgba(127, 29, 29, 0.55) !important;
        }
      `}</style>
      {/* Hidden element to measure text width for adaptive resizing */}
      <span 
        ref={spanRef}
        className={embedded ? 'lwi-measure' : "invisible absolute font-serif text-6xl md:text-9xl tracking-[0.04em] whitespace-pre pointer-events-none"}
        aria-hidden="true"
      >
        {value || placeholder || ''}
      </span>

      <div className={embedded ? 'lwi-frame' : "relative max-w-full flex justify-center h-full items-center transition-[width,max-width] duration-300 ease-out"}>
        <div className={embedded ? 'lwi-field' : "relative w-fit max-w-full"}>
          <input
            ref={assignInputRef}
            id={id}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            type="text"
            value={value}
            onChange={(e) => {
              if (embedded) setSelectionPosition(e.target.selectionStart);
              onChange(e.target.value);
            }}
            onSelect={embedded ? (e) => setSelectionPosition(e.currentTarget.selectionStart) : undefined}
            onCompositionStart={(e) => { composing.current = true; onCompositionStart?.(e); }}
            onCompositionEnd={(e) => { composing.current = false; onCompositionEnd?.(e); }}
            onKeyDown={(e) => {
              if (disabled || composing.current || e.nativeEvent.isComposing || e.keyCode === 229) {
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                onEnter?.();
              }
            }}
            placeholder={placeholder}
            readOnly={disabled}
            spellCheck="false"
            style={embedded ? undefined : { width: inputWidth, maxWidth }}
            className={embedded ? `lwi-input font-serif lwi-status-${status}` : `bg-transparent border-b-4 outline-none py-8 text-center font-serif text-6xl md:text-9xl tracking-[0.04em] transition-[width,color,border-color,filter,transform] duration-300 ease-out placeholder:text-mid-charcoal/30 focus:ring-0 ${
              status === 'correct' 
                ? 'status-correct scale-105' 
                : status === 'wrong' 
                ? 'status-wrong animate-shake' 
                : theme === 'review'
                  ? 'theme-review-idle focus:border-red-400'
                : showWordBlocks 
                  ? 'border-mid-charcoal/20 focus:border-electric-blue/30 text-white'
                  : 'border-mid-charcoal focus:border-electric-blue text-white'
            }`}
            autoFocus={autoFocus}
            autoComplete={embedded ? 'off' : undefined}
            autoCapitalize={embedded ? 'none' : undefined}
          />

          {showProcessingOverlay && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-charcoal/70 backdrop-blur-sm border border-mid-charcoal/40 px-4">
              <div className="flex flex-col items-center gap-2 text-electric-blue animate-pulse">
                <div className="flex items-center gap-3 font-headline text-lg md:text-2xl whitespace-nowrap">
                  <span className="material-symbols-outlined animate-spin">sync</span>
                  <span>{processingLabel || (isZh ? '正在验证…' : 'VALIDATING…')}</span>
                </div>
                {!!processingTotalSteps && !!processingStep && (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] tracking-widest text-electric-blue/80">{processingStep}/{processingTotalSteps}</span>
                    <div className="flex items-center gap-1.5">
                      {Array.from({ length: processingTotalSteps }).map((_, index) => {
                        const active = index < processingStep;
                        return (
                          <span
                            key={index}
                            className={`h-1.5 w-1.5 rounded-full transition-all ${active ? 'bg-electric-blue shadow-[0_0_8px_rgba(0,240,255,0.7)]' : 'bg-mid-charcoal/80'}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {hintOverlay && (
          <div 
            className="absolute inset-0 flex items-center justify-center pointer-events-none font-serif text-6xl md:text-9xl text-electric-blue/20 tracking-[0.04em] whitespace-pre"
            aria-hidden="true"
          >
            {hintOverlay}
          </div>
        )}

        {/* The same positional hints serve the standard test and compact game layouts. */}
        {showWordBlocks && targetWord && (
          <div
            className={embedded ? 'lwi-blocks' : 'absolute bottom-2 inset-x-0 flex justify-center items-center pointer-events-none'}
            aria-hidden="true"
          >
            <div
              className={embedded ? 'lwi-positions' : 'flex gap-2 md:gap-4 px-4'}
              style={embedded
                ? { maxWidth: `${Math.max(220, positionCount * 38)}px` }
                : { width: inputWidth, maxWidth: maxWidth === 'calc(100vw - 6rem)' ? 'calc(100vw - 4rem)' : maxWidth }}
            >
              {Array.from({ length: positionCount }, (_, i) => {
                const isInputReady = enteredLetters.length > i;
                const isCorrect = isInputReady && enteredLetters[i]?.toLowerCase() === targetLetters[i]?.toLowerCase();
                const positionState = isInputReady ? (isCorrect ? 'correct' : 'wrong') : i === currentPosition && embedded ? 'current' : 'empty';
                return (
                  <div
                    key={i}
                    data-position={i + 1}
                    data-state={positionState}
                    data-current={embedded && i === currentPosition ? 'true' : undefined}
                    data-extra={i >= targetLetters.length ? 'true' : undefined}
                    className={embedded ? 'lwi-position' : `h-1.5 md:h-2 flex-1 rounded-full transition-all duration-300 ${
                      status === 'correct'
                        ? 'bg-electric-green shadow-[0_0_15px_rgba(46,230,124,0.6)]'
                        : status === 'wrong'
                          ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.4)]'
                          : !isInputReady
                            ? 'bg-white/10'
                            : isCorrect
                              ? 'bg-electric-green shadow-[0_0_10px_rgba(46,230,124,0.4)]'
                              : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.4)]'
                    }`}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
