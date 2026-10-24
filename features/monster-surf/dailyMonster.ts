import type { SurfState } from './types.ts';

/** Matches the homepage: Sunday is M0, using the player's local calendar. */
export const getDailySurfMonster = (date = new Date()): number => date.getDay();

/** Local midnight, including 23/25-hour days when daylight saving time changes. */
export function millisecondsUntilNextSurfDay(date = new Date()): number {
  const midnight = new Date(date);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - date.getTime();
}

/** A new calendar day changes the introduction; a run keeps its original rider. */
export function refreshDailySurfMonster(state: SurfState, date = new Date()): SurfState {
  if (state.phase !== 'ready') return state;
  const monster = getDailySurfMonster(date);
  return monster === state.monster ? state : { ...state, monster };
}
