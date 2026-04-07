import { DayStats, WordEntry, InputSession } from '../types';
import { getShanghaiDateString } from '../utils/timezone';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  category: 'PROCESS' | 'ACCURACY';
  maxProgress: number; // The target value to reach
  emoji: string;
  imagePrompt: string; // Description for generation
}

export const ACHIEVEMENTS: Achievement[] = [
  // Process
  {
    id: 'p_novice',
    title: 'Novice Explorer',
    description: 'Add your first word to the library',
    category: 'PROCESS',
    maxProgress: 1,
    emoji: '🚩',
    imagePrompt: 'A weathered bronze compass lying on an ancient map, symbolizing the start of a journey. Cinematic lighting, realistic texture.'
  },
  {
    id: 'p_consistency',
    title: 'Consistency',
    description: 'Maintain a 7-day learning streak',
    category: 'PROCESS',
    maxProgress: 7,
    emoji: '🔥',
    imagePrompt: 'A small but bright orange flame burning steadily on a stone torch holder. Warm glow, dark background.'
  },
  {
    id: 'p_dedication',
    title: 'Dedication',
    description: 'Maintain a 30-day learning streak',
    category: 'PROCESS',
    maxProgress: 30,
    emoji: '🌊',
    imagePrompt: 'A stylized blue ocean wave cresting, representing the rhythmic power of habit. Dynamic motion, deep blue tones.'
  },
  {
    id: 'p_hoarder',
    title: 'Word Hoarder',
    description: 'Add 100 words to your collection',
    category: 'PROCESS',
    maxProgress: 100,
    emoji: '🎒',
    imagePrompt: 'An adventurous leather traveler\'s backpack overflowing with glowing magical scrolls. Fantasy style.'
  },
  {
    id: 'p_builder',
    title: 'Library Builder',
    description: 'Collect 1000 words',
    category: 'PROCESS',
    maxProgress: 1000,
    emoji: '🏰',
    imagePrompt: 'A towering stone library turret with a golden light shining from the high arched window. Mysterious and grand.'
  },
  // Accuracy
  {
    id: 'a_bullseye',
    title: 'Bullseye',
    description: 'Complete a "Perfect Session" (100% correct)',
    category: 'ACCURACY',
    maxProgress: 1,
    emoji: '🎯',
    imagePrompt: 'A golden arrow striking the exact center of a red and white target. High contrast, sharp focus.'
  },
  {
    id: 'a_sharp',
    title: 'Sharp Mind',
    description: 'Achieve >80% global accuracy',
    category: 'ACCURACY',
    maxProgress: 80,
    emoji: '⚡',
    imagePrompt: 'A bright blue lightning bolt striking a metallic surface, sparking energy and arcs of electricity. Cyberpunk aesthetic.'
  },
  {
    id: 'a_precision',
    title: 'Precision Master',
    description: 'Complete 5 Perfect Sessions',
    category: 'ACCURACY',
    maxProgress: 5,
    emoji: '💎',
    imagePrompt: 'A perfectly cut, geometrically symmetrical sapphire floating in zero gravity. Deep blue sparkle, clean background.'
  },
  {
    id: 'a_veteran',
    title: 'Veteran',
    description: 'Get 500 correct answers',
    category: 'ACCURACY',
    maxProgress: 500,
    emoji: '🛡️',
    imagePrompt: 'A silver shield with intricate engravings, polished to a mirror finish, reflecting a faint light.'
  },
  {
    id: 'a_grandmaster',
    title: 'Grandmaster',
    description: 'Achieve >90% global accuracy',
    category: 'ACCURACY',
    maxProgress: 90,
    emoji: '👑',
    imagePrompt: 'A jeweled golden crown resting on a rich crimson velvet cushion, emitting a soft magical aura. Royal and majestic.'
  }
];

export interface AchievementStatus {
  id: string;
  unlocked: boolean;
  currentProgress: number;
  formattedProgress: string; // e.g., "5/10" or "85%"
}

const shiftDateString = (dateStr: string, deltaDays: number): string => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + deltaDays);

  const nextYear = utcDate.getUTCFullYear();
  const nextMonth = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
};

const calculateLearningStreak = (sessions: InputSession[], dailyStats?: DayStats[]): number => {
  const activeDates = new Set<string>();

  if (dailyStats && dailyStats.length > 0) {
    dailyStats.forEach(stat => {
      if ((stat.total || 0) > 0) {
        activeDates.add(stat.date);
      }
    });
  } else {
    sessions.forEach(s => {
      const date = new Date(s.timestamp);
      const dateStr = date.toISOString().split('T')[0];
      activeDates.add(dateStr);
    });
  }

  if (activeDates.size === 0) {
    return 0;
  }

  const sortedDates = Array.from(activeDates).sort().reverse();
  const today = getShanghaiDateString();
  const yesterday = shiftDateString(today, -1);

  if (sortedDates[0] !== today && sortedDates[0] !== yesterday) {
    return 0;
  }

  let streak = 1;
  let currentDate = sortedDates[0];

  for (let i = 1; i < sortedDates.length; i++) {
    const expectedPrevDate = shiftDateString(currentDate, -1);
    if (sortedDates[i] === expectedPrevDate) {
      streak++;
      currentDate = sortedDates[i];
    } else {
      break;
    }
  }

  return streak;
};

export function calculateAchievements(words: WordEntry[], sessions: InputSession[], dailyStats?: DayStats[]): AchievementStatus[] {
    // 1. Calculate base metrics
    
    // Total Words - ONLY count manually added words (tags includes 'Custom')
    // Exclude words imported from dictionaries (Primary, CET4, etc.)
    const manuallyAddedWords = words.filter(w => 
        w.tags && w.tags.includes('Custom')
    );
    const totalManualWords = manuallyAddedWords.length;
    
    // Total Correct Answers (all words, including library imports)
    const totalCorrect = words.filter(w => w.correct).length;
    
    // Global Accuracy (all words, including library imports)
    const testedWords = words.filter(w => w.tested);
    const globalAccuracy = testedWords.length > 0 
        ? Math.round((words.filter(w => w.correct).length / testedWords.length) * 100)
        : 0;

    // Perfect Sessions
    // A session is perfect if it has associated words, and ALL of those words are correct.
    // We assume sessions without any words (e.g. deleted words) don't count.
    
    // Group words by session ID for efficient lookup
    const wordsBySession: Record<string, WordEntry[]> = {};
    words.forEach(w => {
        if (!wordsBySession[w.sessionId]) wordsBySession[w.sessionId] = [];
        wordsBySession[w.sessionId].push(w);
    });

    let perfectSessionsCount = 0;
    sessions.forEach(s => {
        const sessionWords = wordsBySession[s.id] || [];
        // Only count if session has words and all are correct
        if (sessionWords.length > 0 && sessionWords.every(w => w.correct)) {
            perfectSessionsCount++;
        }
    });

    const streak = calculateLearningStreak(sessions, dailyStats);

    // 2. Map to achievements
    return ACHIEVEMENTS.map(ach => {
        let current = 0;
        let unlocked = false;

        switch (ach.id) {
            case 'p_novice':
                current = totalManualWords; // Only manually added words
                unlocked = current >= ach.maxProgress;
                break;
            case 'p_consistency':
            case 'p_dedication':
                current = streak;
                unlocked = current >= ach.maxProgress;
                break;
            case 'p_hoarder':
            case 'p_builder':
                current = totalManualWords; // Only manually added words
                unlocked = current >= ach.maxProgress;
                break;
            case 'a_bullseye':
            case 'a_precision':
                current = perfectSessionsCount;
                unlocked = current >= ach.maxProgress;
                break;
            case 'a_sharp':
            case 'a_grandmaster':
                current = globalAccuracy;
                unlocked = current >= ach.maxProgress;
                break;
            case 'a_veteran':
                current = totalCorrect;
                unlocked = current >= ach.maxProgress;
                break;
        }

        // Formatted String
        let formatted = `${current} / ${ach.maxProgress}`;
        if (ach.category === 'ACCURACY' && (ach.id === 'a_sharp' || ach.id === 'a_grandmaster')) {
            formatted = `${current}% / ${ach.maxProgress}%`;
        }
        
        // Determine unlocking for percentages more carefully
        if (ach.category === 'ACCURACY' && (ach.id === 'a_sharp' || ach.id === 'a_grandmaster')) {
             if (current >= ach.maxProgress) {
                 unlocked = true;
             }
        }

        return {
            id: ach.id,
            unlocked,
            currentProgress: current,
            formattedProgress: formatted
        };
    });
}
