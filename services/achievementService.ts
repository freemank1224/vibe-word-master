import { WordEntry, InputSession } from '../types';

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
    description: 'Maintain a 3-day learning streak',
    category: 'PROCESS',
    maxProgress: 3,
    emoji: '🔥',
    imagePrompt: 'A small but bright orange flame burning steadily on a stone torch holder. Warm glow, dark background.'
  },
  {
    id: 'p_dedication',
    title: 'Dedication',
    description: 'Maintain a 7-day learning streak',
    category: 'PROCESS',
    maxProgress: 7,
    emoji: '🌊',
    imagePrompt: 'A stylized blue ocean wave cresting, representing the rhythmic power of habit. Dynamic motion, deep blue tones.'
  },
  {
    id: 'p_hoarder',
    title: 'Word Hoarder',
    description: 'Add 50 words to your collection',
    category: 'PROCESS',
    maxProgress: 50,
    emoji: '🎒',
    imagePrompt: 'An adventurous leather traveler\'s backpack overflowing with glowing magical scrolls. Fantasy style.'
  },
  {
    id: 'p_builder',
    title: 'Library Builder',
    description: 'Collect 200 words',
    category: 'PROCESS',
    maxProgress: 200,
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

export function calculateAchievements(words: WordEntry[], sessions: InputSession[]): AchievementStatus[] {
    // 1. Calculate base metrics
    
    // Total Words
    const totalWords = words.length;
    
    // Total Correct Answers
    const totalCorrect = words.filter(w => w.correct).length;
    
    // Global Accuracy
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

    // Streak Calculation
    // Extract unique dates from sessions
    const uniqueDates = new Set<string>();
    sessions.forEach(s => {
        const date = new Date(s.timestamp);
        // Correctly handle timezone or use local date string? 
        // Assuming simple day continuity is desired.
        const dateStr = date.toISOString().split('T')[0];
        uniqueDates.add(dateStr);
    });
    const sortedDates = Array.from(uniqueDates).sort().reverse(); // Newest first

    let streak = 0;
    if (sortedDates.length > 0) {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        
        // Check if streak is currently active (last session was today or yesterday)
        let isActive = false;
        if (sortedDates[0] === today || sortedDates[0] === yesterday) {
            isActive = true;
        }

        if (isActive) {
            streak = 1;
            let currentDate = new Date(sortedDates[0]); // Start with the most recent active day
            
            for (let i = 1; i < sortedDates.length; i++) {
                const prevDateStr = sortedDates[i];
                
                // Calculate the date before the current date in the loop
                const expectedPrevDate = new Date(currentDate);
                expectedPrevDate.setDate(currentDate.getDate() - 1);
                const expectedPrevDateStr = expectedPrevDate.toISOString().split('T')[0];

                if (prevDateStr === expectedPrevDateStr) {
                    streak++;
                    currentDate = new Date(prevDateStr);
                } else {
                    break;
                }
            }
        }
    }

    // 2. Map to achievements
    return ACHIEVEMENTS.map(ach => {
        let current = 0;
        let unlocked = false;

        switch (ach.id) {
            case 'p_novice':
                current = totalWords;
                unlocked = current >= ach.maxProgress;
                break;
            case 'p_consistency':
            case 'p_dedication':
                current = streak;
                unlocked = current >= ach.maxProgress;
                break;
            case 'p_hoarder':
            case 'p_builder':
                current = totalWords;
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
