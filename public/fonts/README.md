# Material Symbols subset

This project self-hosts 81 Material Symbols Outlined icons used by its current screens and leaderboard data. The 24,588-byte WOFF2 includes `opsz=24`, `GRAD=0`, `wght=400..600` and `FILL=0..1`, preserving the filled coin icon. It contains no text typeface and does not depend on an external font host at runtime.

Source: Google's [Material Symbols documentation](https://developers.google.com/fonts/docs/material_symbols) and Google Fonts CSS API. The exact CSS request, font URL, retrieval date, icon list and SHA-256 are in `material-symbols-manifest.json`. The font is distributed under the adjacent `MaterialSymbols-LICENSE.txt` (Apache 2.0, Google LLC).

To update the subset:

1. Add the new icon names to the alphabetically sorted `icon_names` list in the manifest's `stylesheetSource` URL. Keep the existing axes so coins retain their fill and stroke weight.
2. Fetch that stylesheet from the official Google Fonts API and download its WOFF2 URL. Do not copy the full 3,800+ icon font.
3. Compute the font's SHA-256 and rename it to `material-symbols-<first 12 SHA-256 characters>.woff2`. Update the manifest's file, byte count, SHA, source URLs and retrieval date.
4. Update the single font preload in `index.html` and `@font-face` URL in `styles/global.css` to the new fingerprint. Remove the superseded subset file.
5. Run `node --test __tests__/startup/*.test.ts` and browser-check the added icon. The source coverage test catches new literal, conditional, picker, status and leaderboard icon names that are missing from the manifest. Dynamic icons from a new external source also need an explicit manifest entry and browser check.

The local font is preloaded, but font completion never blocks React startup. The small icon footprint is reserved until the font loads so ligature names cannot distort button layouts. Decorative text fonts remain optional asynchronous downloads.
