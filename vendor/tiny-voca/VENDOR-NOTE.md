# Vendored: tiny-voca (browser TTS fallback)

- Upstream: https://github.com/n4ze3m/tiny-voca
- License: Apache-2.0 (code + weights) — full text in `LICENSE`
- Vendored at upstream commit: `15a36abbe58ef84c4e9aabf5868207ff28f15deb` (js/ directory)
- Files taken as-is (unmodified): `tiny-voca.js`, `text.js`, `dizione/*.js`, upstream `js/README.md` (kept alongside as `README.upstream.md` when present)
- Model artifact: `public/models/tiny-voca-js.gguf` — upstream `gguf/tiny-voca-js.gguf` (~7.6 MB, contains model weights AND the phonemizer tables)
- Local additions (this wrapper): `index.ts`, `VENDOR-NOTE.md`

Usage in this app: `services/localTtsService.ts` synthesizes English word
pronunciations in the browser when the MiniMax-backed online pipeline is
unavailable. Voice is pinned to `M2` (upstream male speaker).
