import React, { useEffect, useMemo, useState } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { WordStrikeLeaderboardEntry, WordStrikeLeaderboardMetric, WordStrikeLeaderboardScope } from '../types';
import { fetchWordStrikeLeaderboard } from '../services/dataService';

interface WordStrikeLeaderboardPanelProps {
  showTitle?: boolean;
  scope?: WordStrikeLeaderboardScope;
  onScopeChange?: (scope: WordStrikeLeaderboardScope) => void;
  viewDate?: Date;
  onViewDateChange?: (date: Date) => void;
  showDateControls?: boolean;
}

const metricMeta: Record<WordStrikeLeaderboardMetric, { icon: string; label: { en: string; zh: string } }> = {
  total_score: { icon: 'workspace_premium', label: { en: 'Total Score', zh: '总分' } },
  accuracy_rate: { icon: 'target', label: { en: 'Accuracy', zh: '正确率' } },
  speed_score: { icon: 'bolt', label: { en: 'Speed', zh: '速度' } },
  combo_score: { icon: 'local_fire_department', label: { en: 'Combo', zh: '连击' } },
};

const metricLabels: Record<WordStrikeLeaderboardMetric, { en: string; zh: string }> = {
  total_score: { en: 'Total Score', zh: '总分' },
  accuracy_rate: { en: 'Accuracy', zh: '正确率' },
  speed_score: { en: 'Speed', zh: '速度' },
  combo_score: { en: 'Combo', zh: '连击' },
};

const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const metricDescription = (metric: WordStrikeLeaderboardMetric, value: number) => {
  if (metric === 'accuracy_rate') {
    return `${Math.round(value * 100)}%`;
  }
  return `${Math.round(value)}`;
};

export const WordStrikeLeaderboardPanel: React.FC<WordStrikeLeaderboardPanelProps> = ({
  showTitle = true,
  scope: controlledScope,
  onScopeChange,
  viewDate: controlledViewDate,
  onViewDateChange,
  showDateControls = true,
}) => {
  const [scope, setScope] = useState<WordStrikeLeaderboardScope>('all_time');
  const [metric, setMetric] = useState<WordStrikeLeaderboardMetric>('total_score');
  const [viewDate, setViewDate] = useState(new Date());
  const [entries, setEntries] = useState<WordStrikeLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeScope = controlledScope ?? scope;
  const activeViewDate = controlledViewDate ?? viewDate;

  const updateScope = (nextScope: WordStrikeLeaderboardScope) => {
    if (controlledScope === undefined) {
      setScope(nextScope);
    }
    onScopeChange?.(nextScope);
  };

  const updateViewDate = (nextDate: Date) => {
    if (controlledViewDate === undefined) {
      setViewDate(nextDate);
    }
    onViewDateChange?.(nextDate);
  };

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchWordStrikeLeaderboard(activeScope, metric, activeViewDate, 8);
        if (!disposed) {
          setEntries(data);
        }
      } catch (err) {
        if (!disposed) {
          console.error('[WordStrikeLeaderboardPanel] failed to load leaderboard', err);
          setError('load_failed');
          setEntries([]);
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      disposed = true;
    };
  }, [activeScope, metric, activeViewDate]);

  const canMoveForward = useMemo(() => formatDate(activeViewDate) < formatDate(new Date()), [activeViewDate]);

  const changeDate = (days: number) => {
    const next = new Date(activeViewDate);
    next.setDate(next.getDate() + days);
    if (formatDate(next) > formatDate(new Date())) {
      return;
    }
    updateViewDate(next);
  };

  const toggleScope = () => {
    updateScope(activeScope === 'daily' ? 'all_time' : 'daily');
  };

  const renderHeaderControl = () => {
    if (!showDateControls) {
      return (
        <div className="text-[10px] font-mono text-text-dark">
          {activeScope === 'daily' ? formatDate(activeViewDate) : 'ALL'}
        </div>
      );
    }

    if (activeScope === 'daily') {
      return (
        <div className="flex items-center gap-2">
          <button
            onClick={() => changeDate(-1)}
            className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal"
          >
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <button
            onClick={toggleScope}
            className="px-3 py-1 font-mono text-xs bg-mid-charcoal hover:bg-electric-green hover:text-white rounded-full text-text-light transition-colors"
          >
            {formatDate(activeViewDate) === formatDate(new Date()) ? (
              <HoverTranslationText text="Today" translation="今天" />
            ) : (
              formatDate(activeViewDate)
            )}
          </button>
          <button
            onClick={() => changeDate(1)}
            disabled={!canMoveForward}
            className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      );
    }

    return (
      <button
        onClick={toggleScope}
        className="rounded-full border border-electric-green/25 bg-electric-green/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-electric-green transition-colors hover:border-electric-blue hover:bg-electric-blue/15 hover:text-electric-blue"
        type="button"
      >
        <HoverTranslationText text="All Time" translation="历史总榜" />
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col space-y-3">
      {showTitle && (
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase">
            <HoverTranslationText text="Strike Rankings" translation="射击排行" />
          </h3>
          {renderHeaderControl()}
        </div>
      )}

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {(Object.keys(metricLabels) as WordStrikeLeaderboardMetric[]).map((nextMetric) => (
          <button
            key={nextMetric}
            onClick={() => setMetric(nextMetric)}
            title={metricLabels[nextMetric].en}
            aria-label={metricLabels[nextMetric].en}
            className={`group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition-colors ${
              metric === nextMetric
                ? 'border-electric-green bg-electric-green/10 text-electric-green'
                : 'border-mid-charcoal bg-dark-charcoal text-text-light hover:border-electric-green/40'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">
              {metricMeta[nextMetric].icon}
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 space-y-2 overflow-y-auto rounded-3xl border border-mid-charcoal bg-dark-charcoal p-3 custom-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-6 text-text-dark">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-4 text-center text-xs font-mono text-red-300">
            <HoverTranslationText text="Failed to load strike rankings." translation="射击排行榜加载失败。" />
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-3 py-4 text-center text-xs font-mono text-text-dark">
            <HoverTranslationText text="No qualified runs yet." translation="还没有达标成绩。" />
          </div>
        )}

        {!loading && !error && entries.map((entry) => (
          <div
            key={`${entry.user_id}-${entry.rank_position}-${metric}`}
            className={`rounded-2xl border px-3 py-3 ${
              entry.is_current_user
                ? 'border-electric-green bg-electric-green/10'
                : 'border-mid-charcoal bg-light-charcoal/20'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-headline text-sm text-white">
                  #{entry.rank_position} {entry.display_name || entry.email_masked || 'Player'}
                </div>
                <div className="mt-1 truncate text-[10px] font-mono text-text-dark">
                  {entry.words_correct}/{entry.words_total} · {Math.round(entry.accuracy_rate * 100)}% · {entry.time_used_seconds}s
                </div>
              </div>
              <div className="shrink-0 text-right font-mono text-xs text-electric-green">
                {metricDescription(metric, entry.metric_value)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
