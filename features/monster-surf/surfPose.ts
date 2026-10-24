import type { SurfActivePhase, SurfPhase } from './types';

export type SurfPose = 'straight' | 'left' | 'right' | 'celebrate' | 'hurt' | 'fall';

export const SURF_POSE_INDEX: Record<SurfPose, number> = {
  straight: 0, left: 1, right: 2, celebrate: 3, hurt: 4, fall: 5,
};

/** Damps the steering signal only; sprite frames themselves never cross-fade. */
export function smoothSurfHeading(previous: number, velocity: number, deltaMs: number): number {
  if (!Number.isFinite(velocity)) return previous;
  if (!Number.isFinite(previous)) return velocity;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return previous;
  return previous + (velocity - previous) * (1 - Math.exp(-Math.min(deltaMs, 200) / 90));
}

/** A wider entry threshold than exit threshold avoids fluttering between carve frames. */
export function chooseSurfPose(
  phase: SurfPhase | SurfActivePhase | null,
  heading: number,
  previous: SurfPose = 'straight',
): SurfPose {
  if (phase === 'sinking' || phase === 'over') return 'fall';
  if (phase === 'hurt') return 'hurt';
  if (phase === 'cleared') return 'celebrate';
  if (phase === 'ready' || phase === 'paused' || phase === null) return 'straight';
  if (heading < -38 || (previous === 'left' && heading < -16)) return 'left';
  if (heading > 38 || (previous === 'right' && heading > 16)) return 'right';
  return 'straight';
}
