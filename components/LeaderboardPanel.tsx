import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { LeaderboardEntry, DayStats, PuzzleLeaderboardScope } from '../types';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';
import { HoverTranslationText } from './HoverTranslationText';
import { PuzzleLeaderboardPanel } from './PuzzleLeaderboardPanel';

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
  const [isFlipped, setIsFlipped] = useState(false);
  const [puzzleScope, setPuzzleScope] = useState<PuzzleLeaderboardScope>('all_time');
  const [puzzleViewDate, setPuzzleViewDate] = useState<Date>(getTodayDate());

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

  const changePuzzleDate = (days: number) => {
    const nextDate = new Date(puzzleViewDate);
    nextDate.setDate(nextDate.getDate() + days);

    if (formatDate(nextDate) > formatDate(new Date())) {
      return;
    }

    setPuzzleViewDate(nextDate);
  };

  const jumpPuzzleToToday = () => {
    setPuzzleViewDate(getTodayDate());
  };

  const togglePuzzleScope = () => {
    setPuzzleScope((current) => (current === 'daily' ? 'all_time' : 'daily'));
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

  const getScoreBreakdown = (entry: LeaderboardEntry) => {
    const leaderboardConfig = WORD_LEARNING_CONFIG.leaderboard;
    const maxTotalScore = 1000;

    const testCountMax = leaderboardConfig.weights.testCount * maxTotalScore;
    const newWordsMax = leaderboardConfig.weights.newWords * maxTotalScore;
    const accuracyMax = leaderboardConfig.weights.accuracy * maxTotalScore;
    const difficultyMax = leaderboardConfig.weights.difficulty * maxTotalScore;

    const computedTestCount = Math.min(
      entry.tests_completed / leaderboardConfig.normalization.testCountCap,
      1
    ) * testCountMax;

    const computedNewWords = Math.min(
      entry.new_words_added / leaderboardConfig.normalization.newWordsCap,
      1
    ) * newWordsMax;

    const computedAccuracy = Math.max(0, Math.min(entry.accuracy_rate, 1)) * accuracyMax;

    const computedDifficulty = Math.min(
      entry.avg_difficulty / leaderboardConfig.normalization.difficultyCap,
      1
    ) * difficultyMax;

    const testCountScore = Number.isFinite(entry.test_count_score)
      ? entry.test_count_score
      : computedTestCount;
    const newWordsScore = Number.isFinite(entry.new_words_score)
      ? entry.new_words_score
      : computedNewWords;
    const accuracyScore = Number.isFinite(entry.accuracy_score)
      ? entry.accuracy_score
      : computedAccuracy;
    const difficultyScore = Number.isFinite(entry.difficulty_score)
      ? entry.difficulty_score
      : computedDifficulty;

    return {
      testCountScore,
      newWordsScore,
      accuracyScore,
      difficultyScore,
    };
  };

  const renderFlipTitle = (text: string, translation: string) => (
    <button
      type="button"
      onClick={() => setIsFlipped(prev => !prev)}
      className="group inline-flex items-center text-left"
    >
      <span className="font-headline text-3xl text-electric-blue tracking-widest uppercase transition-colors group-hover:text-white">
        <HoverTranslationText text={text} translation={translation} />
      </span>
    </button>
  );

  const renderHeader = () => (
    <div className="flex justify-between items-center mb-6">
      <div className="flex flex-col">
        {renderFlipTitle('Leaderboard', '排行榜')}
        <span className="font-mono text-xs text-text-dark tracking-tighter">
          {formatDate(actualDateWithData)}
          {formatDate(actualDateWithData) === formatDate(new Date()) ? (
            <span className="ml-2 text-electric-green text-xs"><HoverTranslationText text="(Real-time)" translation="（实时）" /></span>
          ) : (
            <span className="ml-2 text-text-dark text-xs"><HoverTranslationText text="(Frozen)" translation="（已冻结）" /></span>
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
          <HoverTranslationText text="Today" translation="今天" />
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
  );

  const renderClassicBody = () => {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-electric-blue border-t-transparent mb-4"></div>
            <p className="text-text-dark font-mono text-sm"><HoverTranslationText text="Loading leaderboard..." translation="排行榜加载中..." /></p>
          </div>
        </div>
      );
    }

    if (entries.length === 0) {
      const noDataReason = hasNoDataAtAll ? 'no_global_data' : !qualificationStatus?.qualified ? 'not_qualified' : 'no_data';

      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-5 overflow-hidden py-4">
          {error && (
            <div className="w-full max-w-xs rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-xs font-mono text-red-300">
              <HoverTranslationText text="Failed to load leaderboard." translation="排行榜加载失败。" />
            </div>
          )}

          {noDataReason === 'no_global_data' ? (
            <>
              <div className="text-6xl leading-none">🏆</div>
              <h4 className="font-headline text-xl text-white"><HoverTranslationText text="Be the First!" translation="成为第一个上榜的人！" /></h4>
              {qualificationStatus && qualificationStatus.currentTests !== undefined && (
                <div className="w-full max-w-sm rounded-3xl border border-mid-charcoal bg-mid-charcoal/50 p-4">
                  <div className="flex items-end justify-center gap-3">
                    <div className="text-4xl font-bold leading-none text-electric-blue">{qualificationStatus.currentTests}</div>
                    <div className="pb-1 text-text-dark font-mono text-sm">/ {qualificationStatus.requiredTests} tests today</div>
                  </div>
                  <div className="mt-3 w-full bg-dark-charcoal rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-electric-blue h-full rounded-full transition-all"
                      style={{ width: `${Math.min((qualificationStatus.currentTests / qualificationStatus.requiredTests) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-6xl leading-none">🎯</div>
              <h4 className="font-headline text-xl text-white"><HoverTranslationText text="Almost There!" translation="就快达标了！" /></h4>
              {qualificationStatus && (
                <div className="w-full max-w-sm rounded-3xl border border-mid-charcoal bg-mid-charcoal/50 p-4">
                  <div className="text-center mb-3">
                    <div className="text-text-dark font-mono text-xs mb-1"><HoverTranslationText text="YOUR PROGRESS" translation="你的进度" /></div>
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-4xl font-bold text-electric-blue">{qualificationStatus.currentTests}</span>
                      <span className="text-text-dark font-mono text-lg">/ {qualificationStatus.requiredTests}</span>
                    </div>
                  </div>
                  <div className="w-full bg-dark-charcoal rounded-full h-3 mb-2 overflow-hidden">
                    <div
                      className="bg-electric-blue h-3 rounded-full transition-all"
                      style={{ width: `${Math.min((qualificationStatus.currentTests / qualificationStatus.requiredTests) * 100, 100)}%` }}
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
            className="px-6 py-2 bg-electric-blue text-white font-mono text-sm rounded-full hover:bg-electric-blue/80 transition-colors"
          >
            Refresh Status
          </button>
        </div>
      );
    }

    const currentUserEntry = entries.find(e => e.is_current_user);

    return (
      <>
        <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
          {entries.map((entry) => {
            const scoreBreakdown = getScoreBreakdown(entry);

            return (
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
                      <span className="relative group/name cursor-default">
                        {entry.display_name}
                        {entry.email_masked && entry.display_name !== entry.email_masked && (
                          <span className="absolute left-0 top-full mt-1 hidden group-hover/name:block z-30 whitespace-nowrap px-2 py-1 rounded-lg bg-dark-charcoal border border-mid-charcoal text-xs text-text-light font-mono shadow-xl pointer-events-none">
                            {entry.email_masked}
                          </span>
                        )}
                      </span>
                      {entry.is_current_user && <span className="ml-2 text-xs text-electric-blue">(You)</span>}
                    </div>
                    <div className="font-mono text-xs text-text-dark">
                      {entry.tests_completed} tests • {entry.new_words_added} new • {(entry.accuracy_rate * 100).toFixed(0)}% acc
                    </div>
                  </div>
                </div>
                <div className="text-right relative group">
                  <div className="font-bold text-white font-mono">{Math.round(entry.total_score)}</div>
                  <div className="font-mono text-xs text-text-dark">points</div>
                  <div className="absolute right-0 top-full mt-1 hidden group-hover:block z-20 w-48 p-2 rounded-xl border border-mid-charcoal bg-dark-charcoal shadow-2xl">
                    <div className="font-mono text-[11px] text-text-light space-y-0.5 leading-tight">
                      <div className="flex justify-between"><span>Tests</span><span>{scoreBreakdown.testCountScore.toFixed(1)}</span></div>
                      <div className="flex justify-between"><span>New</span><span>{scoreBreakdown.newWordsScore.toFixed(1)}</span></div>
                      <div className="flex justify-between"><span>Accuracy</span><span>{scoreBreakdown.accuracyScore.toFixed(1)}</span></div>
                      <div className="flex justify-between"><span>Difficulty</span><span>{scoreBreakdown.difficultyScore.toFixed(1)}</span></div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

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
                <div className="font-mono text-xl text-white">{Math.round(currentUserEntry.total_score)}</div>
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
      </>
    );
  };

  return (
    <div className="min-h-[420px]" style={{ perspective: '2000px' }}>
      <div
        className="relative min-h-[420px] transition-transform duration-700"
        style={{
          transformStyle: 'preserve-3d',
          transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        <div
          className="absolute inset-0 bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl flex flex-col"
          style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
        >
          {renderHeader()}
          {renderClassicBody()}
        </div>

        <div
          className="absolute inset-0 bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl flex flex-col"
          style={{
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
          }}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="flex flex-col">
              {renderFlipTitle('Game Winner', '游戏赢家')}
              <span className="mt-1 font-mono text-xs text-text-dark tracking-tighter">
                <HoverTranslationText text="Puzzle Game Rankings" translation="字谜游戏排行榜" />
              </span>
            </div>
            {puzzleScope === 'daily' ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => changePuzzleDate(-1)}
                  className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal"
                >
                  <span className="material-symbols-outlined">chevron_left</span>
                </button>
                <button
                  onClick={togglePuzzleScope}
                  className="px-3 py-1 font-mono text-xs bg-mid-charcoal hover:bg-electric-blue hover:text-white rounded-full text-text-light transition-colors"
                >
                  {formatDate(puzzleViewDate) === formatDate(new Date()) ? (
                    <HoverTranslationText text="Today" translation="今天" />
                  ) : (
                    formatDate(puzzleViewDate)
                  )}
                </button>
                <button
                  onClick={() => changePuzzleDate(1)}
                  disabled={formatDate(puzzleViewDate) >= formatDate(new Date())}
                  className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </button>
              </div>
            ) : (
              <button
                onClick={togglePuzzleScope}
                className="rounded-full border border-electric-green/25 bg-electric-green/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-electric-green transition-colors hover:border-electric-blue hover:bg-electric-blue/15 hover:text-electric-blue"
                type="button"
              >
                <HoverTranslationText text="All Time" translation="历史总榜" />
              </button>
            )}
          </div>
          <PuzzleLeaderboardPanel
            showTitle={false}
            scope={puzzleScope}
            onScopeChange={setPuzzleScope}
            viewDate={puzzleViewDate}
            onViewDateChange={setPuzzleViewDate}
            showDateControls={false}
          />
        </div>
      </div>
    </div>
  );
};
