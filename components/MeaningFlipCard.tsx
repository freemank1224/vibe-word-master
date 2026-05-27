import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WordMeaningOption } from '../types';

interface MeaningFlipCardProps {
  front: React.ReactNode;
  meaning?: string | null;
  meaningOptions?: WordMeaningOption[] | null;
  selectedMeaningKey?: string | null;
  className?: string;
  frontClassName?: string;
  backClassName?: string;
  disabled?: boolean;
}

const faceStyle: React.CSSProperties = {
  backfaceVisibility: 'hidden',
  WebkitBackfaceVisibility: 'hidden',
};

const meaningPreviewStyle: React.CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
};

export const MeaningFlipCard: React.FC<MeaningFlipCardProps> = ({
  front,
  meaning,
  meaningOptions,
  selectedMeaningKey,
  className = '',
  frontClassName = '',
  backClassName = '',
  disabled = false,
}) => {
  const [isFlipped, setIsFlipped] = useState(false);
  const [isMeaningOverlayOpen, setIsMeaningOverlayOpen] = useState(false);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const meaningTriggerRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const overlayCloseTimerRef = useRef<number | null>(null);
  const normalizedMeaningOptions = (meaningOptions || []).filter(option => option?.meaningZh?.trim());
  const selectedMeaning = normalizedMeaningOptions.find(option => option.key === selectedMeaningKey);
  const displayMeaning = selectedMeaning?.meaningZh || meaning?.trim() || normalizedMeaningOptions[0]?.meaningZh || '暂无中文释义';

  const clearOverlayCloseTimer = () => {
    if (overlayCloseTimerRef.current !== null) {
      window.clearTimeout(overlayCloseTimerRef.current);
      overlayCloseTimerRef.current = null;
    }
  };

  const openMeaningOverlay = () => {
    if (normalizedMeaningOptions.length === 0) return;
    clearOverlayCloseTimer();
    setIsMeaningOverlayOpen(true);
  };

  const closeMeaningOverlay = () => {
    clearOverlayCloseTimer();
    setIsMeaningOverlayOpen(false);
  };

  const scheduleMeaningOverlayClose = () => {
    clearOverlayCloseTimer();
    overlayCloseTimerRef.current = window.setTimeout(() => {
      setIsMeaningOverlayOpen(false);
      overlayCloseTimerRef.current = null;
    }, 100);
  };

  useEffect(() => {
    return () => clearOverlayCloseTimer();
  }, []);

  useLayoutEffect(() => {
    if (!isMeaningOverlayOpen || !meaningTriggerRef.current || !overlayRef.current) return;

    const updatePosition = () => {
      if (!meaningTriggerRef.current || !overlayRef.current) return;

      const triggerRect = meaningTriggerRef.current.getBoundingClientRect();
      const overlayRect = overlayRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 12;

      let left = triggerRect.left;
      let top = triggerRect.bottom + gap;

      if (left + overlayRect.width > viewportWidth - gap) {
        left = viewportWidth - overlayRect.width - gap;
      }
      if (left < gap) {
        left = gap;
      }

      if (top + overlayRect.height > viewportHeight - gap) {
        top = triggerRect.top - overlayRect.height - gap;
      }
      if (top < gap) {
        top = Math.max(gap, viewportHeight - overlayRect.height - gap);
      }

      setOverlayStyle({
        position: 'fixed',
        top,
        left,
        maxWidth: Math.min(448, viewportWidth - gap * 2),
        maxHeight: Math.min(420, viewportHeight - gap * 2),
        opacity: 1,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isMeaningOverlayOpen]);

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
          <div className="flex h-full flex-col rounded-inherit">
            <div className="min-w-0 overflow-hidden">
              <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-gray-500">中文释义</p>
              <button
                ref={meaningTriggerRef}
                type="button"
                onClick={(event) => event.stopPropagation()}
                onMouseEnter={openMeaningOverlay}
                onMouseLeave={scheduleMeaningOverlayClose}
                onFocus={openMeaningOverlay}
                onBlur={scheduleMeaningOverlayClose}
                className="mt-3 block w-full cursor-help overflow-hidden rounded-lg text-left outline-none"
              >
                <p
                  className="text-sm leading-relaxed text-white sm:text-base"
                  style={meaningPreviewStyle}
                >
                  {displayMeaning}
                </p>
              </button>
            </div>
          </div>
        </div>
      </div>
      {isMeaningOverlayOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={overlayRef}
          style={overlayStyle}
          onMouseEnter={openMeaningOverlay}
          onMouseLeave={scheduleMeaningOverlayClose}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          className="z-[9999] overflow-auto rounded-2xl border border-white/10 bg-[#0e1015]/95 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-md"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-electric-blue/80">全部常见释义</p>
          <div className="mt-3 space-y-2.5">
            {normalizedMeaningOptions.map((option) => {
              const isSelected = option.key === selectedMeaningKey || (!selectedMeaningKey && option.meaningZh === displayMeaning);
              return (
                <div
                  key={option.key}
                  className={`rounded-xl border px-3 py-2 ${isSelected ? 'border-amber-300/45 bg-amber-300/10' : 'border-white/6 bg-white/[0.03]'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ${isSelected ? 'bg-amber-300/15 text-amber-200' : 'bg-electric-blue/10 text-electric-blue'}`}>
                      {option.partOfSpeech || '未标注词性'}
                    </span>
                    {isSelected && <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-200">当前记录</span>}
                  </div>
                  <p className="mt-2 break-words text-sm leading-relaxed text-white">{option.meaningZh}</p>
                  {option.definitionEn && (
                    <p className="mt-1 break-words text-xs leading-relaxed text-gray-400">{option.definitionEn}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
