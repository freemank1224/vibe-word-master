import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { LeaderboardEntry, DayStats } from '../types';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';

interface LeaderboardPanelProps {
  selectedDate?: Date;
  stats?: Record<string, DayStats>;
  words?: any[];
}

/**
 * User's qualification status for leaderboard
 */
interface QualificationStatus {
  qualified: boolean;
  reason?: string;
  currentTests?: number;
  requiredTests?: number;
  canQualify?: boolean;
}

/**
 * Format date to YYYY-MM-DD string
 */
const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Get today's date
 */
const getTodayDate = (): Date => {
  return new Date();
};

/**
 * Get current user's qualification status
 */
const getQualificationStatus = (
  userTests: number,
  minRequired: number
): QualificationStatus => {
  const qualified = userTests >= minRequired;

  return {
    qualified,
    currentTests: userTests,
    requiredTests: minRequired,
    canQualify: true,
    reason: qualified
      ? undefined
      : userTests === 0
        ? 'start_taking_tests'
        : 'need_more_tests',
  };
};

export const LeaderboardPanel: React.FC<LeaderboardPanelProps> = ({
  selectedDate,
  stats = {},
  words = []
}) => {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewDate, setViewDate] = useState<Date>(selectedDate || getTodayDate());
  const [qualificationStatus, setQualificationStatus] = useState<QualificationStatus | null>(null);
  const [hasNoDataAtAll, setHasNoDataAtAll] = useState(false);
  const [actualDateWithData, setActualDateWithData] = useState<Date>(selectedDate || getTodayDate());

  useEffect(() => {
    if (selectedDate) {
      setViewDate(selectedDate);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchLeaderboard();
  }, [viewDate]);

  const fetchLeaderboard = async () => {
    setLoading(true);
    setError(null);
    setHasNoDataAtAll(false);

    try {
      let dateStr = formatDate(viewDate);

      // Prevent querying future dates
      const today = formatDate(new Date());
      if (dateStr > today) {
        dateStr = today;
        setViewDate(new Date());
      }

      const { data, error } = await supabase.rpc('get_leaderboard', {
        p_date: dateStr,
        p_limit: 100,
        p_include_current_user: true,
      });

      if (error) {
        console.error('Failed to fetch leaderboard:', error);
        setError('Failed to load leaderboard');
        setLoading(false);
        return;
      }

      // Set the actual date and data
      // Today's rankings are real-time, historical rankings are frozen
      if (!data || data.length === 0) {
        setActualDateWithData(viewDate);
        setHasNoDataAtAll(true);
        setEntries([]);
      } else {
        setActualDateWithData(viewDate);
        setEntries(data as LeaderboardEntry[]);
      }

      // Get current user's stats for the actual data date
      const dateKey = formatDate(viewDate);
      const userStats = stats[dateKey];
      const currentTests = userStats?.total || 0;
      const minRequired = WORD_LEARNING_CONFIG.leaderboard.qualification.minTestsPerDay;

      setQualificationStatus(
        getQualificationStatus(currentTests, minRequired)
      );
    } catch (err) {
      console.error('Error fetching leaderboard:', err);
      setError('An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const changeDate = (days: number) => {
    const newDate = new Date(viewDate);
    newDate.setDate(newDate.getDate() + days);

    // Prevent navigating to future dates
    const today = formatDate(new Date());
    const newDateStr = formatDate(newDate);

    if (newDateStr > today) {
      return; // Block future dates
    }

    setViewDate(newDate);
  };

  const jumpToToday = () => {
    setViewDate(getTodayDate());
  };

  const getRankIcon = (rank: number): string => {
    switch (rank) {
      case 1: return '🥇';
      case 2: return '🥈';
      case 3: return '🥉';
      default: return `#${rank}`;
    }
  };

  const getRankColor = (rank: number): string => {
    if (rank === 1) return 'text-yellow-400';
    if (rank === 2) return 'text-gray-300';
    if (rank === 3) return 'text-orange-400';
    return 'text-electric-blue';
  };

  if (loading) {
    return (
      <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl min-h-[500px] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-electric-blue border-t-transparent mb-4"></div>
          <p className="text-text-dark font-mono text-sm">Loading leaderboard...</p>
        </div>
      </div>
    );
  }

  // Empty state with motivation
  if (entries.length === 0) {
    const noDataReason = hasNoDataAtAll
      ? 'no_global_data'
      : !qualificationStatus?.qualified
        ? 'not_qualified'
        : 'no_data';

    return (
      <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl min-h-[500px] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex flex-col">
            <h3 className="font-headline text-3xl text-electric-blue tracking-widest uppercase">Leaderboard</h3>
            <span className="font-mono text-xs text-text-dark tracking-tighter">
              {formatDate(actualDateWithData)}
              {formatDate(actualDateWithData) === formatDate(new Date()) ? (
                <span className="ml-2 text-electric-green text-xs">(Real-time)</span>
              ) : (
                <span className="ml-2 text-text-dark text-xs">(Frozen)</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => changeDate(-1)}
              className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal"
            >
              <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <button
              onClick={jumpToToday}
              className="px-3 py-1 font-mono text-xs bg-mid-charcoal hover:bg-electric-blue hover:text-white rounded-full text-text-light transition-colors"
            >
              Today
            </button>
            <button
              onClick={() => changeDate(1)}
              className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={formatDate(viewDate) >= formatDate(new Date())}
            >
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          </div>
        </div>

        {/* Motivational Empty State */}
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          {noDataReason === 'no_global_data' ? (
            // No one has qualified yet today
            <>
              <div className="text-6xl mb-4">🏆</div>
              <h4 className="font-headline text-xl text-white mb-2">Be the First!</h4>
              <p className="text-text-dark font-mono text-sm text-center max-w-md mb-6">
                No rankings yet for this date. Complete {WORD_LEARNING_CONFIG.leaderboard.qualification.minTestsPerDay} tests
                to become the first leader on the board!
              </p>
              {qualificationStatus && qualificationStatus.currentTests !== undefined && (
                <div className="bg-mid-charcoal/50 rounded-2xl p-4 mb-6">
                  <div className="flex items-center gap-3">
                    <div className="text-3xl font-bold text-electric-blue">
                      {qualificationStatus.currentTests}
                    </div>
                    <div className="text-text-dark font-mono text-sm">
                      / {qualificationStatus.requiredTests} tests today
                    </div>
                  </div>
                  <div className="w-full bg-dark-charcoal rounded-full h-2 mt-2">
                    <div
                      className="bg-electric-blue h-2 rounded-full transition-all"
                      style={{
                        width: `${Math.min(
                          (qualificationStatus.currentTests / qualificationStatus.requiredTests) * 100,
                          100
                        )}%`
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            // User hasn't qualified yet
            <>
              <div className="text-6xl mb-4">🎯</div>
              <h4 className="font-headline text-xl text-white mb-2">Almost There!</h4>
              <p className="text-text-dark font-mono text-sm text-center max-w-md mb-6">
                To appear on the leaderboard, you need to complete at least{' '}
                <span className="text-electric-blue font-bold">
                  {WORD_LEARNING_CONFIG.leaderboard.qualification.minTestsPerDay} tests
                </span>{' '}
                in a single day.
              </p>
              {qualificationStatus && (
                <div className="bg-mid-charcoal/50 rounded-2xl p-4 mb-6">
                  <div className="text-center mb-3">
                    <div className="text-text-dark font-mono text-xs mb-1">YOUR PROGRESS</div>
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-4xl font-bold text-electric-blue">
                        {qualificationStatus.currentTests}
                      </span>
                      <span className="text-text-dark font-mono text-lg">
                        / {qualificationStatus.requiredTests}
                      </span>
                    </div>
                  </div>
                  <div className="w-full bg-dark-charcoal rounded-full h-3 mb-2">
                    <div
                      className="bg-electric-blue h-3 rounded-full transition-all"
                      style={{
                        width: `${Math.min(
                          (qualificationStatus.currentTests / qualificationStatus.requiredTests) * 100,
                          100
                        )}%`
                      }}
                    />
                  </div>
                  <div className="text-center text-text-dark font-mono text-xs">
                    {qualificationStatus.requiredTests - qualificationStatus.currentTests} more test
                    {qualificationStatus.requiredTests - qualificationStatus.currentTests > 1 ? 's' : ''} to go!
                  </div>
                </div>
              )}
            </>
          )}

          <button
            onClick={fetchLeaderboard}
            className="mt-6 px-6 py-2 bg-electric-blue text-white font-mono text-sm rounded-full hover:bg-electric-blue/80 transition-colors"
          >
            Refresh Status
          </button>
        </div>
      </div>
    );
  }

  // Top 3 entries
  const top3 = entries.slice(0, 3);
  const currentUserEntry = entries.find(e => e.is_current_user);

  return (
    <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl flex flex-col min-h-[500px]">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex flex-col">
          <h3 className="font-headline text-3xl text-electric-blue tracking-widest uppercase">Leaderboard</h3>
          <span className="font-mono text-xs text-text-dark tracking-tighter">
            {formatDate(actualDateWithData)}
            {formatDate(actualDateWithData) === formatDate(new Date()) ? (
              <span className="ml-2 text-electric-green text-xs">(Real-time)</span>
            ) : (
              <span className="ml-2 text-text-dark text-xs">(Frozen)</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => changeDate(-1)}
            className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal"
          >
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <button
            onClick={jumpToToday}
            className="px-3 py-1 font-mono text-xs bg-mid-charcoal hover:bg-electric-blue hover:text-white rounded-full text-text-light transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => changeDate(1)}
            className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={formatDate(viewDate) >= formatDate(new Date())}
          >
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      </div>

      {/* Top 3 Podium */}
      <div className="flex justify-center items-end gap-4 mb-8 py-4">
        {top3.map((entry, index) => (
          <div
            key={entry.user_id}
            className={`flex flex-col items-center ${index === 0 ? 'scale-110' : ''}`}
          >
            <div className={`text-4xl mb-2 ${getRankColor(entry.rank_position)}`}>
              {getRankIcon(entry.rank_position)}
            </div>
            <div className={`text-center ${index === 0 ? 'transform -translate-y-2' : ''}`}>
              <div className={`font-bold text-sm ${entry.is_current_user ? 'text-electric-blue' : 'text-white'}`}>
                {entry.display_name}
                {entry.is_current_user && <span className="ml-1 text-xs">(You)</span>}
              </div>
              <div className="font-mono text-xs text-electric-blue">
                {Math.round(entry.total_score)} pts
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Rankings List */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
        {entries.map((entry, index) => (
          <div
            key={entry.user_id}
            className={`flex items-center justify-between p-3 rounded-2xl transition-all ${
              entry.is_current_user
                ? 'bg-electric-blue/20 border border-electric-blue shadow-lg shadow-electric-blue/10'
                : 'bg-mid-charcoal/50 hover:bg-mid-charcoal border border-transparent'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 text-center font-mono font-bold ${getRankColor(entry.rank_position)}`}>
                {getRankIcon(entry.rank_position)}
              </div>
              <div>
                <div className={`font-bold text-sm ${entry.is_current_user ? 'text-electric-blue' : 'text-white'}`}>
                  {entry.display_name}
                  {entry.is_current_user && <span className="ml-2 text-xs text-electric-blue">(You)</span>}
                </div>
                <div className="font-mono text-xs text-text-dark">
                  {entry.tests_completed} tests • {entry.new_words_added} new • {(entry.accuracy_rate * 100).toFixed(0)}% acc
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-bold text-white font-mono">{Math.round(entry.total_score)}</div>
              <div className="font-mono text-xs text-text-dark">points</div>
            </div>
          </div>
        ))}
      </div>

      {/* User's Ranking Summary */}
      {currentUserEntry && (
        <div className="mt-6 pt-4 border-t border-mid-charcoal">
          <div className="flex justify-between items-center">
            <div className="text-center">
              <div className="font-mono text-xs text-text-dark">Your Ranking</div>
              <div className={`font-headline text-3xl ${getRankColor(currentUserEntry.rank_position)}`}>
                {getRankIcon(currentUserEntry.rank_position)}
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-xs text-text-dark">Score</div>
              <div className="font-mono text-xl text-white">
                {Math.round(currentUserEntry.total_score)}
              </div>
            </div>
            <div className="text-center">
              <div className="font-mono text-xs text-text-dark">Percentile</div>
              <div className="font-mono text-xl text-electric-blue">
                {entries.length > 0
                  ? Math.round(((entries.length - currentUserEntry.rank_position + 1) / entries.length) * 100)
                  : 0}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
