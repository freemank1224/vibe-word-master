import type { SurfArtCrop } from './art';

/** One conversion for the entire atlas. Never derive sprite scale from an obstacle radius. */
export const SURF_ISLAND_SOURCE_TO_WORLD = 0.9;

export interface SurfIslandArt {
  name: string;
  size: 'small' | 'medium' | 'large';
  crop: SurfArtCrop;
  /** Land center in crop-relative source pixels, not the center of the tree canopy. */
  anchorX: number;
  anchorY: number;
  collisionRx: number;
  collisionRy: number;
}

// Measured on islands-native-v4.png (1254 × 1254). Crops retain transparent edge padding.
// Solid-land radii exclude the shallow-water halo; all dimensions share the same world scale.
const SOURCE_ISLAND_ART = [
  { name: 'Palm islet', size: 'small', crop: { x: 109, y: 149, width: 192, height: 205 },
    anchorX: 95, anchorY: 156, landRx: 85, landRy: 32 },
  { name: 'Coral skerry', size: 'small', crop: { x: 522, y: 148, width: 207, height: 205 },
    anchorX: 102, anchorY: 158, landRx: 88, landRy: 31 },
  { name: 'Fisher’s rest', size: 'small', crop: { x: 916, y: 143, width: 264, height: 222 },
    anchorX: 133, anchorY: 177, landRx: 113, landRy: 36 },
  { name: 'Crescent beach', size: 'medium', crop: { x: 59, y: 513, width: 289, height: 248 },
    anchorX: 143, anchorY: 178, landRx: 133, landRy: 54 },
  { name: 'Lighthouse cay', size: 'medium', crop: { x: 468, y: 490, width: 309, height: 278 },
    anchorX: 155, anchorY: 219, landRx: 139, landRy: 46 },
  { name: 'Fishing village', size: 'large', crop: { x: 891, y: 502, width: 322, height: 279 },
    anchorX: 160, anchorY: 195, landRx: 144, landRy: 60 },
  { name: 'Palm grove', size: 'large', crop: { x: 37, y: 881, width: 353, height: 294 },
    anchorX: 178, anchorY: 216, landRx: 160, landRy: 57 },
  { name: 'Old stone arch', size: 'medium', crop: { x: 501, y: 944, width: 338, height: 230 },
    anchorX: 168, anchorY: 165, landRx: 154, landRy: 49 },
] as const;

export const SURF_ISLAND_ART: readonly SurfIslandArt[] = SOURCE_ISLAND_ART.map(({ landRx, landRy, ...art }) => ({
  ...art, collisionRx: landRx * SURF_ISLAND_SOURCE_TO_WORLD,
  collisionRy: landRy * SURF_ISLAND_SOURCE_TO_WORLD,
}));
