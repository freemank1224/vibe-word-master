# Native-scale islands — V4

The V2 renderer derived every island sprite's width from each obstacle's radius. The same island could be a small shore prop or a large central obstacle, shrinking/enlarging its trees and huts with it. V4 removes that dependency.

## Shipped source and physical scale

- Built-in imagegen, transparent PNG, copied unchanged into `public/monster-surf/islands-native-v4.png` (1254 × 1254). Eight isolated sprites in a three-column grid. Original alpha preserved; no Python image editing, resampling, background removal or asset stretching.
- Source: `/Users/softmaple/.codex/generated_images/01a1640e-4f93-76e0-8052-5f94cf5cd7db/exec-91b66017-7680-4e17-bb1f-edfa62dbcddc.png`.
- One source pixel = 0.6 game world units for every island. The scene's viewport conversion then scales all world objects together. Individual obstacle radii never control art dimensions.
- Palms, huts and rocks use a common illustrated scale with natural shape variation. Larger islands gain land and additional structures, not proportionally enlarged props. The lighthouse is intentionally taller than a hut.
- `features/monster-surf/islandArt.ts` contains alpha crops, land-center anchors and measured solid-ground ellipses; transparent shallow water is excluded from collision radii.
- Shore locations use the three naturally small islets. Main obstacles use the five medium/large designs. An island retains the same dimensions wherever it appears.

## V6 scene-proportion calibration — 2026-10-24

The original V4 measurements above are retained as historical context. The current game uses **0.9 world units per source pixel**, increasing every island and its contents by the same 50%. The source PNG is unchanged. Solid-ground radii are now stored in source pixels and converted through this same factor, so coastlines and collision footprints remain aligned.

All seven surfers and their attached wakes, gulls, injury stars and splashes use **0.68 of the previous rider scale**; board collision shares that calibration. Central islands still begin at 1050 world units with 670 spacing. Shore islets use 335 spacing, offset by half that interval from central islands, so the enlarged beaches cannot merge or block the passage. Native small/medium/large island shapes and equal illustrated tree/building scale remain intact.

## Final generation prompt

```text
Use case: stylized-concept. Create a single transparent production sprite atlas, 1536x1536 square. Layout EXACTLY THREE COLUMNS by THREE ROWS, each cell512x512, EIGHT separate islands in reading order with bottom-right ninth cell EMPTY. At least100px of TRANSPARENT EMPTY GAP between islands, margins60px, never touching. Each sprite stays inside central390px of its512px cell.
Orthographic45-degree elevated illustrated2D tropical game art with dark teal outlines, cream sand, peach shore bevel, jade/emerald palms, cinnamon trunks, coral/amber huts. Elegant detailed charming handpainted assets for a bright turquoise surfing game. True alpha outside sprites, no background.
WORLD SCALE INVARIANT: All eight islands share identical pixels-per-meter. Every coconut palm tree is140px tall including crown and trunk, crown90px wide. Every hut85px wide and85px high. Every ordinary boulder22px wide. Do not fit each island to its cell. Small islands remain physically much smaller than large islands; the large ones have MORE objects and MORE land, not enlarged trees, huts, rocks. Use one common canonical palm design consistently, subtle organic lean allowed but no size changes.
Cell1 SMALL: native ground140x75px, one palm140px tall,3rocks22px.
Cell2 SMALL: ground160x80px, one palm140px tall,5small coralclumps22px.
Cell3 SMALL: ground180x100px, onehut85px and onepalm140px, littlefishingnet.
Cell4 MEDIUM: ground280x135px, crescentbeach with3palms140px and4rocks22px.
Cell5 MEDIUM: ground300x150px, lighthouse180px (differenttype legitimatelytaller), onehut85px and2palms140px.
Cell6 LARGE: ground370x210px, fishingvillage4huts85px,3palms140px, littledock andbaskets.
Cell7 LARGE: ground370x210px, jungle7palms140px, individual canopies90px each, lowbushes. NO oversized central tree.
Cell8 MEDIUM: ground290x140px, ruinarch100px high, walls60px high,2palms140px androcks22px.
Cell9 empty transparent.
STRICT: small islands retain ample blank padding. Larger island shorelines are still at least60px away from cell borders. A thin shallow-water outline hugging the shore is fine but NO wide glow, NO ocean panels. Complete uncropped land edges, tree crowns, buildings. No text, rulers, borders, gridlines or numbers. Exactly8 isolatedsprites. Prioritize equal tree and hut scale and clean separation.
```

## Final packing correction

The earlier atlas attempts packed the bottom islands too closely. The final edit increases transparent gutters using a shared reduction, preserving relative island and object scale. The shipped image is consumed as generated.

```text
Edit this exact game sprite atlas. Apply ONE specific change: shrink ALL EIGHT COMPLETE ISLAND SPRITES to 65 percent of their current pixel size, all by exactly the SAME global factor. Center each reduced sprite in its existing cell in the three-column, three-row grid. Do not resize the canvas. Keep bottom-right cell empty. The resulting image must have much more completely transparent negative space: at least one entire palm crown width of blank transparent gap between every island, and a half palm crown width of blank margin at the outside edges. This is essential for cropping game sprites. Preserve the native size differences: small islets still half the width of the biggest islands, palm tree sizes remain consistent everywhere. Keep the illustration details, colors, eight islands and composition within each island identical. Do not normalize islands to equal size, do not fill the empty padding, do not add anything. Output real transparent PNG.
```

## Verification entry points

- `qa/island-scale-gallery.html`: all eight native-size islands with equal source-pixel rulers. Its actual-renderer probe asserts fixed source scale and pixel-identical output even if instance radii are changed by different factors.
- `qa/island-scale-gallery.html?view=scene`: small, medium and large islands together in the actual game renderer.
- `scripts/monster-surf/browser-regression.py`: desktop-only functional and layout regression through gstack browse.
