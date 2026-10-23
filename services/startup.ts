/** React owns readiness; optional images and external fonts never gate input. */
export function revealApplication(doc: Document): void {
  if (doc.documentElement.dataset.appReady === 'true') return;
  doc.documentElement.dataset.appReady = 'true';
  doc.getElementById('loading-screen')?.remove();
  doc.defaultView?.performance.mark('vocab-app-ready');
}

/** The preloaded icon subset is local; decorative fonts stay independent. */
export function prepareIconFont(doc: Document): void {
  if (!doc.fonts?.load) return;
  void doc.fonts.load('400 24px "Material Symbols Outlined"', 'check').then((faces) => {
    if (faces.length > 0 && faces.every(face => face.status === 'loaded')) {
      doc.documentElement.classList.add('symbols-ready');
    }
  }).catch(() => {
    // A failed local asset cannot expose long ligature strings or block startup.
  });
}
