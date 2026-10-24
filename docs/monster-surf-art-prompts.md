# Monster Surf generated art

Historical V2 generation record. The current game uses `islands-native-v4.png` and seven dedicated surfing character sheets; the old `islands-atlas.png` stays in the local archive and is excluded from this commit. The gull atlas remains in use.

Built with the built-in `imagegen` tool on 2026-10-23. Original PNG pixels and alpha are preserved. Runtime crops are in `features/monster-surf/art.ts`; this is a 2D Canvas implementation, with no 3D model or engine.

- `public/monster-surf/islands-atlas.png`: eight tropical islands (palms, lighthouse, village, rock arch, jungle, ruins, shipwreck, coral).
- `public/monster-surf/gulls-atlas.png`: four seagull wing poses.
- Characters remain the project's original `public/monsterImages/M0.webp`–`M6.webp`.

## Island prompt

Use case: stylized-concept. Asset type: transparent PNG environment SPRITE ATLAS for a polished 2D cartoon surfing game.
Create EXACTLY EIGHT isolated tropical island game sprites, in a perfectly regular FOUR columns by TWO rows grid, one sprite centered in each equal cell. Landscape canvas 1536x1024. Generous fully transparent gutters at least 30 pixels around every sprite. No connecting scenery. Camera is consistent high three-quarter overhead view, like a charming top-down 2D surfing game, never photorealistic or 3D render. Each island's sand footprint is a wide oval or organic blob seen from above. Ground center near 75% down its sprite, buildings and palms above it. Strong readable clean silhouettes, soft bold teal outlines, hand-drawn clean cel-shaded cartoon illustration, subtle detail and broad color shapes.
Left-to-right TOP ROW:
1. Crescent pale sand island with TWO curving lush palms, tufted grass, three smooth gray rocks.
2. Small round rocky island with red-and-ivory LIGHTHOUSE, tiny teal roof hut, little dock.
3. Wide sandy fishing village island with TWO turquoise and coral beach huts on stilts, wooden pier and leaning palm.
4. Compact tall gray ROCK ARCH on an irregular rocky patch with small pink coral tufts.
BOTTOM ROW:
5. Lush oval JUNGLE island, huge broadleaf tree canopy, four palms, little cascading pool, varied foliage.
6. Small sandy island with whimsical old stone RUIN, crumbling turquoise arch, vines and two palms.
7. Elongated narrow sandbar with cartoon wooden SHIPWRECK tilted on sand, broken mast, small palms.
8. Tiny pink CORAL REEF and rounded blue-gray rocks with one small palm on miniature sandy patch.
Palette: creamy warm sand, jade and mint foliage, muted teal shadows, coral salmon buildings, ivory highlights. Art must be crisp at game sprite sizes 150-230 px. No text, no numbers, no labels, no UI, no border, no ocean rectangle, no opaque background, no baked checkerboard. Each subject fully contained inside its cell and separate. Actual transparent alpha outside sprites.

## Seagull prompt

Use case: stylized-concept. Asset type: 2D transparent seagull animation sprite sheet for cute cartoon surfing game.
Create ONE consistent white cartoon seagull in FOUR flight poses, arranged in a single horizontal strip of four equally spaced square cells. Each pose is a FULL bird, entirely isolated with generous transparent padding, no contact between cells. SAME bird SAME size and camera in all four: overhead three-quarter view flying toward bottom of the screen, small rounded head pointing downward, yellow-orange beak, dark tiny eyes, compact fluffy white body, pale slate-blue wing shadows, dark ink-teal subtle clean outlines, charcoal wingtip tips. Frame1 wings raised in upstroke, frame2 wings spread wide horizontally, frame3 wings angled downstroke, frame4 wings halfway raised. Charming clean hand-drawn 2D cel-shaded cartoon, broad simple readable shapes, must be legible when 30 pixels wide in game, not realistic, no 3D render, not icon glyph.
True TRANSPARENT alpha background. No water, no scenery, no sky, no shadows, no glow, no labels, no text, no grid lines, no frames. The only opaque pixels should be the four birds. Landscape wide image.
