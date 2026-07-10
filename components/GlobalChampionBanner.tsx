import React, { useEffect, useRef, useState } from 'react';
import {
  ChampionInfo,
  fetchGlobalChampions,
} from '../services/globalLeaderboard';

interface GlobalChampionBannerProps {
  onOpen: () => void;
}

const ROTATION_INTERVAL_MS = 5000;

// Per-category accent colors — rotates the icon + score color for visual variety.
const CATEGORY_ACCENT: Record<string, string> = {
  daily_total: 'text-electric-blue',
  achievements: 'text-electric-purple',
  game_total: 'text-electric-green',
  word_mastery: 'text-electric-blue',
  words_added: 'text-electric-green',
};

/**
 * Rotating "Hall of Fame" banner for the header. Cycles through up to 5
 * all-time champion slides every 5s using a vertical flip animation.
 *
 * - Hidden on screens below `md` (header is too tight on mobile).
 * - Renders nothing while loading/empty so the header layout doesn't shift.
 * - Pauses on hover; click anywhere → onOpen.
 */
const GlobalChampionBanner: React.FC<GlobalChampionBannerProps> = ({ onOpen }) => {
  const [champions, setChampions] = useState<ChampionInfo[]>([]);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const pausedRef = useRef(false);

  // Initial fetch (uses 5-min cache).
  useEffect(() => {
    let disposed = false;
    fetchGlobalChampions()
      .then((rows) => {
        if (disposed) return;
        // Drop any slides that have no champion (empty DB category).
        const valid = rows.filter(
          (c) => c.championUserId && c.championName,
        );
        setChampions(valid);
        setIndex(0);
        setLoaded(true);
      })
      .catch(() => {
        if (disposed) return;
        // Silent: header stays as-is, no error toast in the header.
        setLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Rotation ticker — pauses on hover.
  useEffect(() => {
    if (champions.length <= 1) return;
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setIndex((i) => (i + 1) % champions.length);
    }, ROTATION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [champions.length]);

  if (!loaded || champions.length === 0) {
    // Empty placeholder reserves horizontal space so the header doesn't
    // reflow when data arrives.
    return <div className="min-w-0 flex-1" aria-hidden />;
  }

  const current = champions[index];
  const accent = CATEGORY_ACCENT[current.category] ?? 'text-electric-blue';

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
      onFocus={() => {
        pausedRef.current = true;
      }}
      onBlur={() => {
        pausedRef.current = false;
      }}
      title={`${current.categoryLabel} 冠军 · 点击查看全球排行榜`}
      aria-label={`全球排行榜：${current.categoryLabel} 冠军 ${current.championName}，${current.scoreLabel}`}
      className="group relative flex h-11 max-w-[460px] items-center overflow-hidden rounded-full border border-electric-blue/40 bg-light-charcoal/70 px-4 text-left transition-colors hover:border-electric-blue hover:bg-mid-charcoal/50 cursor-pointer animate-champion-glow"
    >
      {/* Rotating slide — keyed by index so it re-mounts & replays the flip-in animation. */}
      <div
        key={`${current.category}-${index}`}
        className="flex min-w-0 items-center gap-2.5 animate-[champion-flip-in_0.5s_ease]"
      >
        <span className={`material-symbols-outlined text-[22px] ${accent}`}>
          {current.categoryIcon || 'emoji_events'}
        </span>
        <span className="shrink-0 text-xs font-mono uppercase tracking-[0.18em] text-white/70">
          {current.categoryLabel}
        </span>
        <span className="hidden h-4 w-px bg-mid-charcoal sm:inline-block" />
        <span className="truncate text-sm font-semibold text-electric-blue">
          {current.championName}
        </span>
        <span className="hidden shrink-0 font-mono text-sm text-electric-green md:inline-block">
          {current.scoreLabel}
        </span>
      </div>

      {/* Right-edge chevron affordance */}
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-[18px] text-white/40 transition-colors group-hover:text-electric-blue">
        chevron_right
      </span>
    </button>
  );
};

export default GlobalChampionBanner;
