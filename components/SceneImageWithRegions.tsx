import React, { useEffect, useState } from 'react';
import { WordRegion } from '../types';

interface SceneImageWithRegionsProps {
  imageUrl: string;
  regions: WordRegion[];
  /** Index of the word whose region should blink now (null = none). */
  activeWordIndex: number | null;
  /** Region indices that have a persistent ✅ overlay (solved). */
  solvedWordIndices: number[];
  /** Region indices whose answer has been revealed (timeout). Shows the word text. */
  revealedWordIndices: number[];
  /** Increments each time the active word advances — forces the blink to restart. */
  blinkNonce: number;
}

/**
 * Renders the fused scene image with per-word region overlays.
 *  - The active region blinks 3× (green box).
 *  - Solved regions get a persistent ✅.
 *  - Revealed regions (timeout) show the word text.
 *  - When a region's detection failed, the whole image pulses instead.
 */
export const SceneImageWithRegions: React.FC<SceneImageWithRegionsProps> = ({
  imageUrl,
  regions,
  activeWordIndex,
  solvedWordIndices,
  revealedWordIndices,
  blinkNonce,
}) => {
  const activeRegion = activeWordIndex != null ? regions[activeWordIndex] : null;
  const activeFailed = Boolean(activeRegion?.detectionFailed);

  // Track whether the 3× blink is still running so the box stays highlighted (dim) afterwards.
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (activeWordIndex == null) {
      setBlinking(false);
      return;
    }
    setBlinking(true);
    const t = window.setTimeout(() => setBlinking(false), 1500); // 3 × 0.45s + margin
    return () => window.clearTimeout(t);
  }, [activeWordIndex, blinkNonce]);

  return (
    <div className="relative mx-auto w-full max-w-[min(70vh,560px)]">
      <style>{`
        @keyframes scene-region-blink {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 4px rgba(163,255,0,0.95), 0 0 22px rgba(163,255,0,0.45); }
          50%      { opacity: 0.2; box-shadow: 0 0 0 4px rgba(163,255,0,0.25); }
        }
        .scene-region-blinking { animation: scene-region-blink 0.45s ease-in-out 3; }
        .scene-region-active {
          border: 3px solid rgba(163,255,0,0.85);
          box-shadow: 0 0 18px rgba(163,255,0,0.4);
          background: rgba(163,255,0,0.08);
        }
        @keyframes scene-image-pulse {
          0%, 100% { box-shadow: inset 0 0 0 0 rgba(163,255,0,0); }
          50%      { box-shadow: inset 0 0 0 10px rgba(163,255,0,0.7); }
        }
        .scene-image-pulsing { animation: scene-image-pulse 0.45s ease-in-out 3; }
        @keyframes scene-check-pop {
          0%   { transform: scale(0.4); opacity: 0; }
          60%  { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .scene-check-pop { animation: scene-check-pop 0.35s ease-out; }
      `}</style>

      <div
        key={`img-${activeFailed ? activeWordIndex : 'static'}-${blinkNonce}`}
        className={`relative aspect-square w-full overflow-hidden rounded-[28px] border border-mid-charcoal bg-black/40 ${
          activeFailed && blinking ? 'scene-image-pulsing' : ''
        }`}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Scene"
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-text-dark">
            <span className="material-symbols-outlined text-6xl">image</span>
          </div>
        )}

        {/* Per-word region overlays (skip when detectionFailed for the active word — image pulses instead) */}
        {regions.map((region, index) => {
          if (region.detectionFailed) return null;
          const isActive = index === activeWordIndex;
          const isSolved = solvedWordIndices.includes(index);
          const isRevealed = revealedWordIndices.includes(index);
          if (!isActive && !isSolved && !isRevealed) return null;

          const style: React.CSSProperties = {
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.w * 100}%`,
            height: `${region.h * 100}%`,
          };

          return (
            <div
              key={`region-${index}-${blinkNonce}`}
              style={style}
              className={`absolute rounded-2xl transition-all ${
                isActive && blinking ? 'scene-region-blinking' : isActive ? 'scene-region-active' : ''
              } ${isSolved ? 'bg-electric-green/15' : ''}`}
            >
              {isSolved && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="scene-check-pop rounded-full border border-green-300/40 bg-green-500/25 px-3 py-2 text-3xl backdrop-blur-[1px] md:text-4xl">
                    ✅
                  </div>
                </div>
              )}
              {!isSolved && isRevealed && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/55 px-1 text-center">
                  <span className="font-headline text-base text-white md:text-xl" style={{ fontSize: 'clamp(0.9rem, 3.5vw, 1.4rem)' }}>
                    {region.word}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
