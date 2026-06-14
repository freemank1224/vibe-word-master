import React, { useEffect, useMemo, useState } from 'react';
import { HoverTranslationText } from './HoverTranslationText';
import { SceneLeaderboardEntry, SceneLeaderboardMetric, SceneLeaderboardScope, ScenePlayMode } from '../types';
import { fetchSceneGameLeaderboard } from '../services/sceneGame';

interface SceneLeaderboardPanelProps {
  showTitle?: boolean;
  playMode?: ScenePlayMode;
}

const metricMeta: Record<SceneLeaderboardMetric, { icon: string; en: string; zh: string }> = {
  total_score: { icon: 'workspace_premium', en: 'Total Score', zh: '总分' },
  accuracy_rate: { icon: 'target', en: 'Accuracy', zh: '正确率' },
  speed_score: { icon: 'bolt', en: 'Speed', zh: '速度' },
};

const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const metricDescription = (metric: SceneLeaderboardMetric, value: number) =>
  metric === 'accuracy_rate' ? `${Math.round(value * 100)}%` : `${Math.round(value)}`;

export const SceneLeaderboardPanel: React.FC<SceneLeaderboardPanelProps> = ({ showTitle = true, playMode }) => {
  const [scope, setScope] = useState<SceneLeaderboardScope>('all_time');
  const [metric, setMetric] = useState<SceneLeaderboardMetric>('total_score');
  const [viewDate, setViewDate] = useState(new Date());
  const [entries, setEntries] = useState<SceneLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchSceneGameLeaderboard(scope, metric, playMode, viewDate, 8);
        if (!disposed) setEntries(data);
      } catch (err) {
        if (!disposed) {
          console.error('[SceneLeaderboardPanel] failed to load', err);
          setError('load_failed');
          setEntries([]);
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => { disposed = true; };
  }, [scope, metric, viewDate, playMode]);

  const canMoveForward = useMemo(() => formatDate(viewDate) < formatDate(new Date()), [viewDate]);

  const changeDate = (days: number) => {
    const next = new Date(viewDate);
    next.setDate(next.getDate() + days);
    if (formatDate(next) > formatDate(new Date())) return;
    setViewDate(next);
  };

  const toggleScope = () => setScope((s) => (s === 'daily' ? 'all_time' : 'daily'));

  const renderHeaderControl = () => {
    if (scope === 'daily') {
      return (
        <div className="flex items-center gap-2">
          <button onClick={() => changeDate(-1)} className="rounded-full border border-transparent p-2 text-text-light transition-colors hover:border-mid-charcoal hover:bg-mid-charcoal">
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <button onClick={toggleScope} className="rounded-full bg-mid-charcoal px-3 py-1 font-mono text-xs text-text-light transition-colors hover:bg-purple-500 hover:text-white">
            {formatDate(viewDate) === formatDate(new Date()) ? <HoverTranslationText text="Today" translation="今天" /> : formatDate(viewDate)}
          </button>
          <button onClick={() => changeDate(1)} disabled={!canMoveForward} className="rounded-full border border-transparent p-2 text-text-light transition-colors hover:border-mid-charcoal hover:bg-mid-charcoal disabled:cursor-not-allowed disabled:opacity-30">
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      );
    }
    return (
      <button onClick={toggleScope} type="button" className="rounded-full border border-purple-400/30 bg-purple-500/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-purple-300 transition-colors hover:border-purple-400 hover:bg-purple-500/20">
        <HoverTranslationText text="All Time" translation="历史总榜" />
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col space-y-3">
      {showTitle && (
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-headline text-lg uppercase tracking-[0.2em] text-text-dark">
            <HoverTranslationText text="Scene Rankings" translation="场景排行" />
          </h3>
          {renderHeaderControl()}
        </div>
      )}

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {(Object.keys(metricMeta) as SceneLeaderboardMetric[]).map((nextMetric) => (
          <button
            key={nextMetric}
            onClick={() => setMetric(nextMetric)}
            title={metricMeta[nextMetric].en}
            className={`group relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition-colors ${
              metric === nextMetric
                ? 'border-purple-400 bg-purple-500/10 text-purple-300'
                : 'border-mid-charcoal bg-dark-charcoal text-text-light hover:border-purple-400/40'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">{metricMeta[nextMetric].icon}</span>
          </button>
        ))}
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto rounded-3xl border border-mid-charcoal bg-dark-charcoal p-3">
        {loading && (
          <div className="flex items-center justify-center py-6 text-text-dark">
            <span className="material-symbols-outlined animate-spin">progress_activity</span>
          </div>
        )}
        {!loading && error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-4 text-center font-mono text-xs text-red-300">
            <HoverTranslationText text="Failed to load scene rankings." translation="场景排行榜加载失败。" />
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="rounded-2xl border border-mid-charcoal bg-light-charcoal/20 px-3 py-4 text-center font-mono text-xs text-text-dark">
            <HoverTranslationText text="No qualified runs yet." translation="还没有达标成绩。" />
          </div>
        )}
        {!loading && !error && entries.map((entry) => (
          <div
            key={`${entry.user_id}-${entry.rank_position}-${metric}`}
            className={`rounded-2xl border px-3 py-3 ${
              entry.is_current_user ? 'border-purple-400/50 bg-purple-500/10' : 'border-mid-charcoal bg-light-charcoal/20'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-headline text-sm text-white">
                  #{entry.rank_position} {entry.display_name || entry.email_masked || 'Player'}
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-text-dark">
                  {entry.words_correct}/{entry.words_total} · {Math.round(entry.accuracy_rate * 100)}% · {entry.time_used_seconds}s · {entry.play_mode === 'spell' ? '拼写' : '捞针'}
                </div>
              </div>
              <div className="shrink-0 text-right font-mono text-xs text-purple-300">
                {metricDescription(metric, entry.metric_value)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
