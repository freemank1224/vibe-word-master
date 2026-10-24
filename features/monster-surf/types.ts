export type SurfActivePhase = 'surfing' | 'checkpoint' | 'hurt' | 'cleared' | 'sinking';
export type SurfPhase = 'ready' | SurfActivePhase | 'paused' | 'over';
export type SurfFeedback = 'ready' | 'sail' | 'listen' | 'empty' | 'wrong' | 'collision' | 'correct' | 'over';
export interface SurfWord { answer: string; meaningZh: string; meaningEn: string; }
export type SurfCoinFormation = 'ribbon' | 'matrix' | 'diamond' | 'arc' | 'fan';
export interface SurfCoin {
  id: number; x: number; y: number; collectedAt: number | null;
  /** Stable formation identity and steering spine; never chase its leftmost coin. */
  group?: number; formation?: SurfCoinFormation; guideX?: number;
}
/** The ellipse is the solid sand/rock footprint, excluding tall trees and roofs. */
export interface SurfObstacle { id: number; x: number; y: number; rx: number; ry: number; variant: number; hit: boolean; }
export interface SurfEvent {
  id: number;
  kind: 'checkpoint' | 'correct' | 'hurt' | 'coin' | 'over' | 'sea-warning' | 'sea-approach' | 'sea-escape' | 'sea-attack';
  count?: number;
}
export interface SurfChase {
  phase: 'dormant' | 'warning' | 'chasing' | 'retreating' | 'escaped' | 'attacking';
  /** Elapsed time in this chase phase; all chase clocks freeze while paused. */
  phaseMs: number; escapeStreak: number; mistakes: number;
  /** Distance behind the board in world units. A larger gap is safer. */
  gap: number; targetGap: number;
  /** Remaining speed-boost duration, unlike the elapsed actionMs clock. */
  boostMs: number; action: 'follow' | 'surge' | 'close'; actionMs: number;
}
export interface SurfState {
  phase: SurfPhase; resumePhase: SurfActivePhase | null; phaseMs: number; elapsedMs: number;
  monster: number; x: number; vx: number; distance: number; speed: number;
  checkpoint: number; nextCheckpoint: number; input: string; hits: number;
  correct: number; streak: number; bestStreak: number; coins: number; score: number;
  items: SurfCoin[]; obstacles: SurfObstacle[];
  navigation: 'waiting' | 'guided' | 'locked'; targetX: number; invulnerableMs: number;
  chase: SurfChase;
  feedback: SurfFeedback; event: SurfEvent | null; eventId: number;
}
/** Kept for callers compiled against V1; manual steering is deliberately ignored. */
export interface SurfControls { steer: number; targetX?: number | null; }
export interface SurfRenderer { render: (state: SurfState, reducedMotion: boolean) => void; destroy: () => void; }
export interface MonsterStyle {
  id: number; label: string; nameZh: string; nameEn: string; color: string; image: string;
  /** Alpha-bounded source crop. Source art is kept unchanged. */
  crop?: { x: number; y: number; width: number; height: number };
}
