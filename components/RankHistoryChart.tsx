import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { RankHistoryEntry } from '../types';
import { HoverTranslationText } from './HoverTranslationText';

interface RankHistoryChartProps {
  userId?: string;
  days?: number;
}

/**
 * RankHistoryChart - Displays user's ranking trend over time
 * Shows percentile changes with a line chart
 */
export const RankHistoryChart: React.FC<RankHistoryChartProps> = ({
  userId,
  days = 30
}) => {
  const [history, setHistory] = useState<RankHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRankHistory();
  }, [userId, days]);

  const fetchRankHistory = async () => {
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase.rpc('get_user_rank_history', {
        p_user_id: userId || null,
        p_days: days,
      });

      if (error) {
        console.error('Failed to fetch rank history:', error);
        setError('Failed to load history');
        return;
      }

      setHistory(data || []);
    } catch (err) {
      console.error('Error fetching rank history:', err);
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl min-h-[300px] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-electric-blue border-t-transparent mb-2"></div>
          <p className="text-text-dark font-mono text-xs"><HoverTranslationText text="Loading history..." translation="历史数据加载中..." /></p>
        </div>
      </div>
    );
  }

  if (error || history.length === 0) {
    return (
      <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl min-h-[300px] flex items-center justify-center">
        <div className="text-center">
          <span className="material-symbols-outlined text-4xl text-text-dark mb-2">show_chart</span>
          <p className="text-text-dark font-mono text-xs">
            {error || <HoverTranslationText text="No history data available" translation="暂无历史数据" />}
          </p>
        </div>
      </div>
    );
  }

  // Sort history by date ascending for chart
  const sortedHistory = [...history].reverse();

  // Calculate chart dimensions
  const chartWidth = 400;
  const chartHeight = 180;
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };

  // Get min/max for scaling
  const minPercentile = Math.min(...sortedHistory.map(h => h.percentile));
  const maxPercentile = Math.max(...sortedHistory.map(h => h.percentile));
  const percentileRange = maxPercentile - minPercentile || 1;

  // Calculate point positions
  const points = sortedHistory.map((entry, index) => {
    const x = padding.left + (index / (sortedHistory.length - 1 || 1)) * (chartWidth - padding.left - padding.right);
    const y = padding.top + (1 - (entry.percentile - minPercentile) / percentileRange) * (chartHeight - padding.top - padding.bottom);
    return { x, y, entry };
  });

  // Create SVG path
  const pathD = points.length > 0
    ? `M ${points[0].x} ${points[0].y} ` + points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')
    : '';

  // Create gradient area
  const areaD = points.length > 0
    ? `M ${points[0].x} ${chartHeight - padding.bottom} ` +
      `L ${points[0].x} ${points[0].y} ` +
      points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ') +
      `L ${points[points.length - 1].x} ${chartHeight - padding.bottom} Z`
    : '';

  return (
    <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex flex-col">
          <h3 className="font-headline text-2xl text-electric-blue tracking-widest uppercase"><HoverTranslationText text="30-Day Trend" translation="30 天趋势" /></h3>
          <span className="font-mono text-xs text-text-dark tracking-tighter">
            <HoverTranslationText text="Percentile over time" translation="百分位随时间变化" />
          </span>
        </div>
        <button
          onClick={fetchRankHistory}
          className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors"
        >
          <span className="material-symbols-outlined">refresh</span>
        </button>
      </div>

      {/* Chart */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-auto"
          style={{ maxHeight: '200px' }}
        >
          <defs>
            <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Y-axis labels */}
          <text x={padding.left - 10} y={padding.top + 5} textAnchor="end" className="fill-text-dark font-mono text-xs">
            {maxPercentile}%
          </text>
          <text x={padding.left - 10} y={chartHeight - padding.bottom} textAnchor="end" className="fill-text-dark font-mono text-xs">
            {minPercentile}%
          </text>

          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map(ratio => (
            <line
              key={ratio}
              x1={padding.left}
              y1={padding.top + ratio * (chartHeight - padding.top - padding.bottom)}
              x2={chartWidth - padding.right}
              y2={padding.top + ratio * (chartHeight - padding.top - padding.bottom)}
              stroke="#374151"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />
          ))}

          {/* Area fill */}
          <path
            d={areaD}
            fill="url(#gradient)"
          />

          {/* Line */}
          <path
            d={pathD}
            fill="none"
            stroke="#3b82f6"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Data points */}
          {points.map((point, index) => (
            <g key={index}>
              <circle
                cx={point.x}
                cy={point.y}
                r="4"
                fill="#1e40af"
                className="hover:r-6 transition-all cursor-pointer"
              >
                <title>
                  {new Date(point.entry.rank_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {'\n'}Rank: #{point.entry.rank_position}
                  {'\n'}Score: {Math.round(point.entry.total_score)}
                  {'\n'}Percentile: {point.entry.percentile}%
                </title>
              </circle>
            </g>
          ))}
        </svg>

        {/* X-axis labels (show first and last date) */}
        {sortedHistory.length > 0 && (
          <div className="flex justify-between px-2 mt-1">
            <span className="font-mono text-xs text-text-dark">
              {new Date(sortedHistory[0].rank_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
            <span className="font-mono text-xs text-text-dark">
              {new Date(sortedHistory[sortedHistory.length - 1].rank_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          </div>
        )}
      </div>

      {/* Summary stats */}
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="text-center">
          <div className="font-mono text-xs text-text-dark"><HoverTranslationText text="Best Rank" translation="最佳排名" /></div>
          <div className="font-headline text-lg text-electric-green">
            #{Math.min(...history.map(h => h.rank_position))}
          </div>
        </div>
        <div className="text-center">
          <div className="font-mono text-xs text-text-dark"><HoverTranslationText text="Current" translation="当前排名" /></div>
          <div className="font-headline text-lg text-electric-blue">
            #{history[0]?.rank_position || '-'}
          </div>
        </div>
        <div className="text-center">
          <div className="font-mono text-xs text-text-dark"><HoverTranslationText text="Avg Percentile" translation="平均百分位" /></div>
          <div className="font-headline text-lg text-white">
            {Math.round(history.reduce((sum, h) => sum + h.percentile, 0) / history.length)}%
          </div>
        </div>
      </div>
    </div>
  );
};
