/** Original 2D Inkfin action sheet; source pixels remain untouched. */
export const INKFIN_ATLAS_URL = '/monster-surf/inkfin-atlas-v6.png';
export type SeaMonsterPose = 'emerge' | 'paddle-left' | 'paddle-right' | 'close' | 'attack' | 'retreat';
export interface SeaMonsterCrop {
  x: number; y: number; width: number; height: number;
  /** The centre of the body at its waterline, relative to this crop. */
  anchorX: number; anchorY: number;
}
// Alpha >= 16 bounds, with a small transparent gutter; 512 px cells, 3 × 2.
// One source-pixel scale preserves body size between wider tentacle gestures.
export const INKFIN_CROPS: Record<SeaMonsterPose, SeaMonsterCrop> = {
  emerge: { x: 40, y: 112, width: 436, height: 360, anchorX: 218, anchorY: 290 },
  'paddle-left': { x: 526, y: 63, width: 478, height: 406, anchorX: 225, anchorY: 325 },
  'paddle-right': { x: 1047, y: 68, width: 455, height: 403, anchorX: 242, anchorY: 323 },
  close: { x: 42, y: 553, width: 439, height: 406, anchorX: 219, anchorY: 331 },
  attack: { x: 512, y: 534, width: 512, height: 424, anchorX: 256, anchorY: 350 },
  retreat: { x: 1046, y: 523, width: 462, height: 437, anchorX: 232, anchorY: 364 },
};
