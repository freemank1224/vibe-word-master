import React from 'react';

interface CoinIconProps {
  className?: string;
  fontSize?: string;
}

/**
 * Gold coin icon. Uses material-symbols-outlined with FILL so it always
 * renders as a solid gold coin regardless of platform (the 🪙 emoji
 * renders silver/gray on some devices).
 */
export const CoinIcon: React.FC<CoinIconProps> = ({ className = '', fontSize }) => (
  <span
    className={`material-symbols-outlined text-amber-400 ${className}`}
    style={{
      fontVariationSettings: "'FILL' 1, 'wght' 600",
      ...(fontSize ? { fontSize } : {}),
    }}
  >
    monetization_on
  </span>
);
