export const SURF_WORLD_WIDTH = 1000;
export const SURF_HERO_Y = 0.57;
export const SURF_BASE_SPEED = 145;
export const SURF_BASE_MAGNET = 40;
/** One rider calibration shared by artwork, board collision and route clearance. */
export const SURF_RIDER_SCALE = 0.68;
export const SURF_RIDER_COLLISION_RX = 18 * SURF_RIDER_SCALE;
export const SURF_RIDER_COLLISION_RY = 24 * SURF_RIDER_SCALE;
// Retained as legacy course constants; dictation no longer stops at a checkpoint.
export const SURF_FIRST_CHECKPOINT = 420;
export const SURF_CHECKPOINT_GAP = 640;
export const SURF_MAX_HITS = 3;
/** Earned magnet bonus compounds by50%; guard against numeric overflow in long runs. */
export const surfMagnetMultiplier = (correct: number) => Math.min(1e100, Math.pow(1.5, Math.max(0, correct)));
// Beyond the complete generated sea, a larger physical radius cannot collect
// anything extra. Keep physics finite even after thousands of Endless answers.
export const SURF_MAX_MAGNET_RADIUS = SURF_WORLD_WIDTH * 8;
export const surfMagnetRadius = (correct: number) => Math.min(SURF_MAX_MAGNET_RADIUS, SURF_BASE_MAGNET * surfMagnetMultiplier(correct));
export const SURF_MAX_VISIBLE_GULLS = 32;
/** Earned pace is permanent for this run; an error only breaks the combo. */
export const surfSpeedMultiplier = (correct: number) => 1 + Math.min(1.5, Math.max(0, correct) * 0.08);

export const SURF_CHASE_TRIGGER = 10;
export const SURF_CHASE_ESCAPE_WORDS = 5;
export const SURF_CHASE_MAX_MISTAKES = 3;
export const SURF_CHASE_WARNING_MS = 2_200;
export const SURF_CHASE_RETREAT_MS = 1_800;
export const SURF_CHASE_ATTACK_MS = 1_800;
export const SURF_CHASE_BOOST_MS = 1_800;
export const SURF_CHASE_BOOST_MULTIPLIER = 1.25;
export const SURF_CHASE_ACTION_MS = 700;
export const SURF_CHASE_INITIAL_GAP = 260;
