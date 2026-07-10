import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChampionCategory,
  LeaderboardRow,
  fetchGlobalLeaderboard,
} from '../services/globalLeaderboard';

interface GlobalLeaderboardModalProps {
  open: boolean;
  onClose: () => void;
}

interface CategoryMeta {
  key: ChampionCategory;
  labelZh: string;
  labelEn: string;
  icon: string;
  accent: string; // tailwind text-* class for the active tab
}

const CATEGORIES: CategoryMeta[] = [
  { key: 'daily_total', labelZh: '日常总分', labelEn: 'Daily', icon: 'emoji_events', accent: 'text-electric-blue' },
  { key: 'achievements', labelZh: '成就解锁', labelEn: 'Achv', icon: 'military_tech', accent: 'text-electric-purple' },
  { key: 'game_total', labelZh: '游戏总分', labelEn: 'Game', icon: 'sports_esports', accent: 'text-electric-green' },
  { key: 'word_mastery', labelZh: '单词掌握', labelEn: 'Master', icon: 'verified', accent: 'text-electric-blue' },
  { key: 'words_added', labelZh: '单词添加', labelEn: 'Added', icon: 'library_add', accent: 'text-electric-green' },
];

const MEDAL_EMOJI: Record<number, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

const medalFor = (rank: number) => MEDAL_EMOJI[rank] ?? '';

/**
 * Floating "Global Hall of Fame" panel with 5 category tabs.
 * Each tab lazy-loads its data on first activation, then caches it
 * in-module for instant back-navigation.
 *
 * Close: X button, backdrop click, or Esc.
 */
const GlobalLeaderboardModal: React.FC<GlobalLeaderboardModalProps> = ({
  open,
  onClose,
}) => {
  const [active, setActive] = useState<ChampionCategory>('daily_total');
  // Per-category cache so switching back is instant.
  const [cache, setCache] = useState<Record<string, LeaderboardRow[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<Record<string, string | null>>({});
  const [retryTick, setRetryTick] = useState(0);

  // Latest-fetch tracker: prevents stale writes if user switches tabs mid-fetch.
  const fetchTokenRef = useRef(0);

  // Esc-to-close + body scroll lock.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const loadCategory = useCallback(
    async (category: ChampionCategory) => {
      // Already cached — no-op.
      if (cache[category]) return;
      const token = ++fetchTokenRef.current;
      setLoading((prev) => ({ ...prev, [category]: true }));
      setError((prev) => ({ ...prev, [category]: null }));
      try {
        const rows = await fetchGlobalLeaderboard(category, 10);
        if (token !== fetchTokenRef.current) return; // stale
        setCache((prev) => ({ ...prev, [category]: rows }));
      } catch (err) {
        if (token !== fetchTokenRef.current) return;
        setError((prev) => ({
          ...prev,
          [category]: err instanceof Error ? err.message : 'load_failed',
        }));
      } finally {
        if (token === fetchTokenRef.current) {
          setLoading((prev) => ({ ...prev, [category]: false }));
        }
      }
    },
    [cache],
  );

  // Load active tab on activation (lazy).
  useEffect(() => {
    if (!open) return;
    loadCategory(active);
  }, [open, active, retryTick, loadCategory]);

  const activeRows = cache[active] ?? null;
  const activeLoading = loading[active];
  const activeError = error[active];

  const currentUserRow = useMemo(
    () => activeRows?.find((r) => r.isCurrentUser) ?? null,
    [activeRows],
  );

  // Reset on close so reopening shows a fresh state (cache stays in memory).
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="global-leaderboard-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border-2 border-electric-blue/40 bg-light-charcoal shadow-[0_0_50px_rgba(0,240,255,0.3)]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-mid-charcoal bg-dark-charcoal/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-2xl text-electric-blue">workspace_premium</span>
            <h2
              id="global-leaderboard-title"
              className="font-headline text-xl tracking-[0.16em] text-white"
            >
              全球排行榜
              <span className="ml-2 text-sm font-mono lowercase tracking-[0.2em] text-white/50">
                Global Hall of Fame
              </span>
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded-full p-2 text-white/60 transition-colors hover:bg-mid-charcoal hover:text-white"
          >
            <span className="material-symbols-outlined text-2xl">close</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-mid-charcoal bg-dark-charcoal/40 px-3 py-2 custom-scrollbar">
          {CATEGORIES.map((cat) => {
            const isActive = cat.key === active;
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setActive(cat.key)}
                className={`group relative flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-mono uppercase tracking-[0.16em] transition-colors ${
                  isActive
                    ? 'bg-electric-blue/10 text-white'
                    : 'text-white/50 hover:bg-mid-charcoal hover:text-white/80'
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[20px] ${
                    isActive ? cat.accent : 'text-white/50'
                  }`}
                >
                  {cat.icon}
                </span>
                <span className="hidden sm:inline">{cat.labelZh}</span>
                <span className="sm:hidden">{cat.labelEn}</span>
                {/* Underline */}
                {isActive && (
                  <span className="absolute -bottom-2 left-2 right-2 h-0.5 rounded-full bg-electric-blue" />
                )}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 custom-scrollbar">
          {activeLoading && (
            <div className="flex items-center justify-center py-12 text-white/60">
              <span className="material-symbols-outlined animate-spin text-2xl">
                progress_activity
              </span>
              <span className="ml-3 text-sm font-mono uppercase tracking-[0.24em]">
                加载中…
              </span>
            </div>
          )}

          {!activeLoading && activeError && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-10 text-center">
              <span className="material-symbols-outlined text-3xl text-red-300">
                cloud_off
              </span>
              <p className="text-sm font-mono text-red-300">
                排行榜加载失败 / Failed to load
              </p>
              <button
                type="button"
                onClick={() => setRetryTick((t) => t + 1)}
                className="rounded-full border border-red-400/40 bg-red-500/10 px-5 py-2 text-xs font-mono uppercase tracking-[0.18em] text-red-200 hover:bg-red-500/20"
              >
                重试 Retry
              </button>
            </div>
          )}

          {!activeLoading && !activeError && activeRows && activeRows.length === 0 && (
            <div className="flex items-center justify-center py-12 text-sm font-mono uppercase tracking-[0.2em] text-white/50">
              暂无数据 · No data yet
            </div>
          )}

          {!activeLoading && !activeError && activeRows && activeRows.length > 0 && (
            <ul className="space-y-2">
              {activeRows.map((row) => {
                const medal = medalFor(row.rankPosition);
                const isMe = row.isCurrentUser;
                return (
                  <li
                    key={`${row.userId}-${row.rankPosition}`}
                    className={`flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-colors ${
                      isMe
                        ? 'border-electric-blue/50 bg-electric-blue/10 border-l-2 border-l-electric-blue'
                        : 'border-mid-charcoal bg-dark-charcoal/40 hover:border-electric-blue/30'
                    }`}
                  >
                    {/* Rank / medal */}
                    <div className="w-10 shrink-0 text-center">
                      {medal ? (
                        <span className="text-2xl leading-none">{medal}</span>
                      ) : (
                        <span className="font-mono text-lg text-white/70">
                          {row.rankPosition}
                        </span>
                      )}
                    </div>

                    {/* Avatar / icon fallback */}
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      {row.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={row.avatarUrl}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-full border border-mid-charcoal object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-mid-charcoal bg-dark-charcoal text-xs font-mono uppercase text-white/50">
                          {(row.displayName || row.emailMasked || '?')
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-headline text-base text-white">
                          {row.displayName || row.emailMasked || 'Player'}
                          {isMe && (
                            <span className="ml-2 rounded-full bg-electric-blue/20 px-2 py-0.5 align-middle text-[11px] font-mono uppercase tracking-[0.18em] text-electric-blue">
                              You
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs font-mono text-white/40">
                          {row.emailMasked}
                        </div>
                      </div>
                    </div>

                    {/* Score */}
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm font-semibold text-electric-green">
                        {row.scoreLabel}
                      </div>
                      {row.rankPosition > 3 && (
                        <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-white/40">
                          #{String(row.rankPosition).padStart(2, '0')}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Footer note: user has no score in this category */}
          {!activeLoading &&
            !activeError &&
            activeRows &&
            activeRows.length > 0 &&
            !currentUserRow && (
              <div className="mt-4 rounded-xl border border-mid-charcoal bg-dark-charcoal/30 px-4 py-3 text-center text-xs font-mono text-white/40">
                你还未参与此排行 · You haven&apos;t entered this ranking yet
              </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default GlobalLeaderboardModal;
