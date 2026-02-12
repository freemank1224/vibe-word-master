
import React, { useState } from 'react';
import { DayStats } from '../types';

interface CalendarViewProps {
  stats: Record<string, DayStats>;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ stats }) => {
  const [viewDate, setViewDate] = useState(new Date());
  const [flashingDate, setFlashingDate] = useState<string | null>(null);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  // Adjust for Monday start (0=Sun, 1=Mon... -> 0=Mon, 1=Tue... 6=Sun)
  const firstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const blanks = Array.from({ length: firstDay }, (_, i) => i);

  const getCellColor = (stat?: DayStats) => {
    if (!stat || stat.total === 0) return 'bg-dark-charcoal/50 text-text-dark border-mid-charcoal/30 hover:border-mid-charcoal';

    // Calculate rate based on points if available, else simple correct/total
    let rate = stat.points !== undefined
      ? stat.points / (stat.total * 3)
      : stat.correct / stat.total;

    // CRITICAL: Clamp rate to valid range [0, 1] to prevent >100% or <0%
    rate = Math.max(0, Math.min(1, rate));

    if (stat.total < 10 || rate < 0.5) {
      return 'bg-red-500/40 text-red-400 border-red-500/60';
    }
    if (rate <= 0.70) {
      return 'bg-orange-500/40 text-orange-400 border-orange-500/60';
    }
    if (rate <= 0.80) {
      return 'bg-yellow-500/40 text-yellow-400 border-yellow-500/60';
    }
    if (rate <= 0.90) {
      return 'bg-lime-500/40 text-lime-400 border-lime-500/60';
    }
    return 'bg-electric-green/40 text-electric-green border-electric-green/60';
  };

  const changeMonth = (delta: number) => {
    const newDate = new Date(viewDate);
    newDate.setMonth(newDate.getMonth() + delta);
    setViewDate(newDate);
  };

  const jumpToToday = () => {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
    setViewDate(now);
    // Trigger flash animation
    setFlashingDate(dateStr);
    setTimeout(() => setFlashingDate(null), 5000); // Flash for 5 seconds (5 times)
  };

  return (
    <div className="bg-light-charcoal p-8 rounded-3xl border border-mid-charcoal shadow-2xl flex flex-col min-h-[500px]">
      <div className="flex justify-between items-center mb-8">
        <div className="flex flex-col">
            <h3 className="font-headline text-3xl text-electric-blue tracking-widest uppercase">{monthNames[month]}</h3>
            <span className="font-mono text-sm text-text-dark tracking-tighter">{year}</span>
        </div>
        <div className="flex items-center gap-3">
            <button 
                onClick={() => changeMonth(-1)}
                className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal"
            >
                <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <button 
                onClick={jumpToToday}
                className="px-3 py-1 text-[10px] font-mono border border-mid-charcoal rounded hover:bg-mid-charcoal transition-colors uppercase"
            >
                Today
            </button>
            <button 
                onClick={() => changeMonth(1)}
                className="p-2 hover:bg-mid-charcoal rounded-full text-text-light transition-colors border border-transparent hover:border-mid-charcoal"
            >
                <span className="material-symbols-outlined">chevron_right</span>
            </button>
        </div>
      </div>
      
      <div className="flex-1 grid grid-cols-7 gap-3 h-full">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={`${d}-${i}`} className="text-center text-text-dark text-xs font-black mb-2 opacity-50">{d}</div>
        ))}
        
        {blanks.map(i => <div key={`b-${i}`} className="aspect-square"></div>)}
        
        {days.map(d => {
          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const stat = stats[dateStr];
          const isFrozen = stat?.is_frozen ?? false;

          return (
            <div
              key={d}
              className={`aspect-square rounded-xl border-2 flex flex-col items-center justify-center transition-all duration-300 cursor-default group relative hover:scale-[1.2] hover:z-50 hover:shadow-xl ${getCellColor(stat)} ${dateStr === flashingDate ? 'animate-[pulse_1s_cubic-bezier(0.4,0,0.6,1)_infinite] z-40' : ''}`}
            >
              <span className="text-base font-mono font-bold z-10">{d}</span>

              {/* Tile Glow Effect */}
              <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-10 bg-white transition-opacity pointer-events-none"></div>

              {/* Frozen Badge */}
              {stat && stat.total > 0 && isFrozen && (
                <div className="absolute top-1 right-1 text-[8px] font-mono text-blue-400 opacity-60">
                  🔒
                </div>
              )}

              {stat && stat.total > 0 && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 hidden group-hover:block z-[60] bg-dark-charcoal p-3 rounded-lg text-xs whitespace-nowrap border border-mid-charcoal shadow-2xl pointer-events-none">
                    <p className="font-bold text-white mb-1 flex items-center gap-2">
                        Activity Log
                        {isFrozen && <span className="text-[10px] opacity-60">🔒 FROZEN</span>}
                    </p>
                    <div className="space-y-0.5">
                        <p className="text-text-dark flex justify-between gap-4">
                            <span>Correct:</span>
                            <span className="text-electric-blue font-mono">{stat.correct}</span>
                        </p>
                        <p className="text-text-dark flex justify-between gap-4">
                            <span>Total Words:</span>
                            <span className="text-text-light font-mono">{stat.total}</span>
                        </p>
                        <p className="text-text-dark flex justify-between gap-4 pt-1 border-t border-mid-charcoal/30 mt-1">
                            <span>Accuracy:</span>
                            <span className="text-electric-green font-bold font-mono">
                                {(() => {
                                    const accuracy = stat.points !== undefined
                                        ? (stat.points / (stat.total * 3)) * 100
                                        : (stat.correct / stat.total) * 100;
                                    // CRITICAL: Clamp accuracy to valid range [0, 100]
                                    const clampedAccuracy = Math.max(0, Math.min(100, accuracy));
                                    return Math.round(clampedAccuracy);
                                })()}%
                            </span>
                        </p>
                    </div>
                    <div className="h-1 w-full bg-mid-charcoal mt-2 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-electric-blue transition-all duration-500"
                            style={{
                                width: `${(() => {
                                    const accuracy = stat.points !== undefined
                                        ? (stat.points / (stat.total * 3)) * 100
                                        : (stat.correct / stat.total) * 100;
                                    // CRITICAL: Clamp accuracy to valid range [0, 100]
                                    const clampedAccuracy = Math.max(0, Math.min(100, accuracy));
                                    return clampedAccuracy;
                                })()}%`
                            }}
                        ></div>
                    </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex justify-between items-center px-2 flex-wrap gap-4">
        <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-red-500/40 border border-red-500/60"></div>
                <span className="text-[10px] font-mono text-text-dark uppercase">Low</span>
            </div>
            <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-orange-500/40 border border-orange-500/60"></div>
                <span className="text-[10px] font-mono text-text-dark uppercase">50-70%</span>
            </div>
            <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-yellow-500/40 border border-yellow-500/60"></div>
                <span className="text-[10px] font-mono text-text-dark uppercase">71-80%</span>
            </div>
            <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-lime-500/40 border border-lime-500/60"></div>
                <span className="text-[10px] font-mono text-text-dark uppercase">81-90%</span>
            </div>
            <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm bg-electric-green/40 border border-electric-green/60"></div>
                <span className="text-[10px] font-mono text-text-dark uppercase">Elite</span>
            </div>
        </div>
      </div>
    </div>
  );
};
