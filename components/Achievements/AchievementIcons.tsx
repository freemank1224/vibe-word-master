import React from 'react';

// Maps achievement IDs to SVG components
export const ACHIEVEMENT_ICONS: Record<string, React.ReactNode> = {
  // P1: Novice Explorer (Compass)
  'p_novice': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-1">
      <circle cx="32" cy="32" r="30" className="fill-stone-800 stroke-amber-700" strokeWidth="2" />
      <circle cx="32" cy="32" r="26" className="stroke-stone-600" strokeWidth="1" strokeDasharray="4 2" />
      {/* Compass Star */}
      <path d="M32 8 L38 26 L56 32 L38 38 L32 56 L26 38 L8 32 L26 26 Z" className="fill-amber-600" />
      <path d="M32 8 L32 32 M56 32 L32 32 M32 56 L32 32 M8 32 L32 32" className="stroke-stone-900" strokeWidth="1" opacity="0.5"/>
      {/* Needle */}
      <path d="M32 15 L36 32 L32 49 L28 32 Z" className="fill-red-500" />
      <circle cx="32" cy="32" r="2" className="fill-white" />
    </svg>
  ),

  // P2: Consistency (Flame)
  'p_consistency': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
      <defs>
        <radialGradient id="flameGradient" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(32 40) rotate(-90) scale(40 40)">
          <stop offset="0.1" stopColor="#FEF08A" />
          <stop offset="0.6" stopColor="#F59E0B" />
          <stop offset="1" stopColor="#EF4444" />
        </radialGradient>
      </defs>
      {/* Torch Base */}
      <path d="M22 45 L24 60 H40 L42 45" className="fill-stone-600" />
      {/* Flame */}
      <path d="M32 4 C32 4 18 20 18 36 C18 45 25 50 32 50 C39 50 46 45 46 36 C46 20 32 4 32 4Z" fill="url(#flameGradient)" />
      <path d="M32 18 C32 18 26 26 26 34 C26 38 29 40 32 40 C35 40 38 38 38 34 C38 26 32 18 32 18Z" className="fill-yellow-100" opacity="0.6" />
    </svg>
  ),

  // P3: Dedication (Wave)
  'p_dedication': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-1">
      <circle cx="32" cy="32" r="30" className="fill-sky-950" />
      {/* Back Wave */}
      <path d="M4 42 C12 40 18 32 24 32 C34 32 38 45 50 45 C56 45 60 40 60 40 V58 H4 V42Z" className="fill-cyan-700" />
      {/* Front Wave */}
      <path d="M2 50 C2 50 14 55 26 42 C34 34 46 32 52 38 C56 42 56 50 46 54 C40 56 36 50 36 50" className="stroke-cyan-400" strokeWidth="3" strokeLinecap="round" />
      <path d="M4 52 C10 56 20 56 30 46 C36 40 46 38 54 44 C58 47 54 58 4 58 V52Z" className="fill-cyan-500" />
      <circle cx="50" cy="18" r="6" className="fill-yellow-100" opacity="0.8" />
    </svg>
  ),

  // P4: Word Hoarder (Backpack/Scrolls)
  'p_hoarder': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
       {/* Scrolls sticking out */}
      <rect x="20" y="8" width="8" height="20" rx="2" className="fill-stone-200" transform="rotate(-15 24 18)" />
      <rect x="36" y="8" width="8" height="20" rx="2" className="fill-amber-100" transform="rotate(15 40 18)" />
       {/* Backpack Body */}
      <path d="M12 24 H52 V56 C52 59 49 62 46 62 H18 C15 62 12 59 12 56 V24Z" className="fill-amber-900" />
      {/* Flap */}
      <path d="M12 24 H52 L48 40 H16 L12 24Z" className="fill-amber-700" />
      <circle cx="32" cy="38" r="4" className="fill-yellow-500" />
      {/* Pockets */}
      <rect x="16" y="44" width="12" height="14" rx="2" className="fill-amber-800" />
      <rect x="36" y="44" width="12" height="14" rx="2" className="fill-amber-800" />
    </svg>
  ),

  // P5: Library Builder (Tower)
  'p_builder': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
      {/* Tower Base */}
      <path d="M20 60 H44 V24 H20 V60Z" className="fill-stone-500" />
      {/* Bricks Pattern */}
      <path d="M20 32 H44 M24 32 V36 M36 32 V36 M20 40 H44 M30 40 V44 M20 48 H44 M24 48 V52 M36 48 V52" className="stroke-stone-600" strokeWidth="1" />
      {/* Roof */}
      <path d="M16 24 H48 L32 4 L16 24Z" className="fill-indigo-900" />
      {/* Window */}
      <path d="M28 30 H36 V40 H28 V30Z" className="fill-yellow-400" />
      <circle cx="32" cy="28" r="4" className="fill-yellow-400" />
      {/* Glow */}
      <circle cx="32" cy="32" r="8" className="fill-yellow-400" opacity="0.3" filter="blur(2px)"/>
    </svg>
  ),

  // A1: Bullseye (Arrow in Target)
  'a_bullseye': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-1">
      {/* Target */}
      <circle cx="32" cy="32" r="28" className="fill-white stroke-red-600" strokeWidth="8"/>
      <circle cx="32" cy="32" r="16" className="fill-white stroke-red-600" strokeWidth="8"/>
      <circle cx="32" cy="32" r="6" className="fill-red-600" />
      {/* Arrow */}
      <path d="M50 14 L32 32" className="stroke-stone-400" strokeWidth="3" />
      {/* Fletching */}
      <path d="M54 10 L50 20 M54 10 L44 14" className="stroke-red-500" strokeWidth="2" />
      {/* Shaft sticking out */}
      <line x1="42" y1="22" x2="34" y2="30" className="stroke-stone-800" strokeWidth="2" />
    </svg>
  ),

  // A2: Sharp Mind (Lightning)
  'a_sharp': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
        <filter id="glow">
          <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        <path d="M36 2 L18 32 H30 L26 62 L50 28 H34 L36 2Z" className="fill-blue-500 stroke-blue-300" strokeWidth="2" filter="url(#glow)"/>
        <path d="M36 2 L18 32 H30 L26 62 L50 28 H34 L36 2Z" className="fill-white" opacity="0.4" transform="scale(0.8) translate(10 5)"/>
    </svg>
  ),

  // A3: Precision Master (Sapphire)
  'a_precision': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-3">
      {/* Top Facet */}
      <path d="M20 20 L32 8 L44 20 H20Z" className="fill-blue-300" />
      {/* Middle Facets */}
      <path d="M8 20 L20 20 L32 42 L6 26 Z" className="fill-blue-500" />
      <path d="M56 20 L44 20 L32 42 L58 26 Z" className="fill-blue-500" />
      <path d="M20 20 L44 20 L32 42 Z" className="fill-blue-400" />
      {/* Bottom Facet */}
      <path d="M6 26 L32 58 L8 20 Z" className="fill-blue-700" />
      <path d="M58 26 L32 58 L56 20 Z" className="fill-blue-700" />
      <path d="M32 42 L6 26 L32 58 L58 26 Z" className="fill-blue-600" />
      {/* Sparkle */}
      <path d="M50 10 L52 4 L54 10 L60 12 L54 14 L52 20 L50 14 L44 12 Z" className="fill-white" />
    </svg>
  ),

  // A4: Veteran (Shield)
  'a_veteran': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
      <path d="M12 12 H52 V22 C52 42 32 58 32 58 C32 58 12 42 12 22 V12Z" className="fill-stone-300 stroke-stone-500" strokeWidth="2" />
      {/* Cross Pattern */}
      <path d="M32 12 V58" className="stroke-stone-400" strokeWidth="2" />
      <path d="M12 28 H52" className="stroke-stone-400" strokeWidth="2" />
      {/* Reflection */}
      <path d="M18 16 V22 C18 34 26 44 32 48" className="stroke-white" strokeWidth="2" opacity="0.6" fill="none"/>
      <circle cx="32" cy="22" r="6" className="fill-stone-400" />
    </svg>
  ),

  // A5: Grandmaster (Crown)
  'a_grandmaster': (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-2">
      {/* Cushion */}
      <path d="M12 50 C12 50 12 58 32 58 C52 58 52 50 52 50" className="fill-red-800" />
      {/* Crown Base */}
      <path d="M16 42 H48 L52 22 L42 32 L32 12 L22 32 L12 22 L16 42Z" className="fill-yellow-400 stroke-yellow-600" strokeWidth="2" />
      {/* Jewels */}
      <circle cx="32" cy="46" r="3" className="fill-red-500" />
      <circle cx="32" cy="12" r="3" className="fill-blue-400" />
      <circle cx="12" cy="22" r="2" className="fill-green-400" />
      <circle cx="52" cy="22" r="2" className="fill-green-400" />
      {/* Aura */}
      <circle cx="32" cy="30" r="28" className="stroke-yellow-200" strokeWidth="1" strokeDasharray="2 4" opacity="0.5"/>
    </svg>
  )
};
