# Monster Surf: M4–M6 surfing artwork

Generated with the built-in `image_gen` tool. Original project portraits were viewed and supplied as identity/style references. These are new hand-drawn 2D surfing illustrations, not portrait cutouts placed on boards. Original generated PNGs are copied unchanged, including transparency.

## Assets

| Monster | File | Sheet | Poses |
| --- | --- | --- | --- |
| M4 | `public/monster-surf/characters/M4-surf.png` | 1536 × 1024 RGBA | Straight, left carve, right carve, celebrate, hurt, fall |
| M5 | `public/monster-surf/characters/M5-surf.png` | 1536 × 1024 RGBA | Straight, left carve, right carve, celebrate, hurt, fall |
| M6 | `public/monster-surf/characters/M6-surf.png` | 1536 × 1024 RGBA | Straight, left carve, right carve, celebrate, hurt, fall |

The regular top and bottom row pose order is the same in all atlases. The renderer should use per-pose alpha bounds, not assume all sprites fill equal square cells. The M6 lower row starts at y = 490 to retain the orange party hat without clipping; there is no silhouette overlap. Crop metadata is calculated by read-only alpha inspection at alpha > 12, with two pixels padding; the PNG pixels are not modified.

## Shared prompt

```text
Use case: illustration-story. Asset type: transparent 2D game character sprite atlas. The attached image is an IDENTITY AND HAND-DRAWN STYLE reference, not a pose to reuse. Redraw this exact Vocab Monster character from scratch in SIX distinct dynamic surfing poses and camera/body angles. Preserve the exact monster's color, characteristic eyes, fur shape, proportions and visible weekday lettering. Hand drawn children's book pencil/gouache texture and colored outlines matching the reference; NOT a 3D render, plastic toy, photo, vector icon, or the original standing pose pasted onto a surfboard.
Canvas 1536 by 1024 pixels, a precise regular THREE COLUMN TWO ROW grid, six 512 by 512 invisible cells. One complete full-body character and its surfboard in each cell, centered, consistent scale. All artwork fits within each cell with at least 28 pixels of transparent padding on all four sides. No overlap between cells, no text labels or cell borders. Fully transparent background with clean alpha edges, no ocean, ground, splash, shadows, vignette, cast shadow, or decorative scene. Every board is the SAME cream surfboard with a single wide teal central stripe, pointed nose toward the forward direction (generally toward the bottom of the image), visible as a foreshortened long oval.
Camera is high 45 degree top-down 3/4 front view, for a game traveling downward on screen. Poses MUST be anatomically different, NOT six rotations of one standing picture.
Top left: straight forward, board nose points bottom center, knees deeply bent in low athletic surf stance, feet spaced fore-and-aft on board, torso inclined forward, arms extended in counterbalance, happy focused expression.
Top center: strong LEFT carve, board nose points lower LEFT at 30 degrees, entire torso turned left, one knee compressed and other leg extended, arms counterbalancing turn, face looking left toward travel.
Top right: strong RIGHT carve, board nose points lower RIGHT at 30 degrees, torso turned right, opposite knee compressed, clearly different body view and arm positions, face looking right toward travel.
Bottom left: successful celebration on board, leaning back with both arms raised, bouncing knees, delighted expression.
Bottom center: HURT and losing balance, one foot lifting off board, arms flailing asymmetrically, surprised distressed expression, body twisted.
Bottom right: FALLING off board, character flung sideways into horizontal flying pose with arms out, eyes squeezed, surfboard separated beneath character but both fully contained in cell.
Avoid standing stock pose, extra limbs, extra characters, missing limbs, white/colored background, 3D rendering, lettering other than the correct chest day abbreviation.
```

## Identity additions

### M4

Reference: `public/monsterImages/M4.webp`

M4 Thursday: soft apricot-orange shaggy egg-shaped fluffy monster, huge shiny black eyes with distinctive gold star-shaped highlights, tiny eyebrows, rosy cheeks, happy open mouth. Chest lettering THU in blue. Excitable light-footed surfing personality; keep star highlights in all eyes.

### M5

Reference: `public/monsterImages/M5.webp`

M5 Friday: round coral/salmon-pink shaggy fluffy monster, large black glossy eyes with white highlights, curved eyebrows, rosy cheeks, exuberant wide smile. Chest lettering FRI in rusty orange. Bold energetic surfer, emphatic playful body movements.

### M6

Reference: `public/monsterImages/M6.webp`

M6 Saturday: lemon-yellow stocky shaggy fluffy monster with distinctive single orange cone-shaped party hat perched on top-right of head, big white eyes with small black pupils, relaxed little curved smile. Chest lettering SAT in blue. Playful careful surfer; preserve orange party hat in every pose including falling.
