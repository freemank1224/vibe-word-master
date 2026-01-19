
import { supabase } from '../lib/supabaseClient';
import { aiService } from './ai';
import { updateWordStatusV2 } from './dataService';

export interface CleanupStats {
    totalProcessed: number;
    deletedSingleLetter: number;
    corrected: number;
    deletedInvalid: number;
    issues: { id: string, text: string }[];
}

export const cleanExistingWords = async (userId: string): Promise<CleanupStats> => {
    const stats: CleanupStats = {
        totalProcessed: 0,
        deletedSingleLetter: 0,
        corrected: 0,
        deletedInvalid: 0,
        issues: []
    };

    try {
        // ... (fetch words)
        const { data: words, error } = await supabase
            .from('words')
            .select('id, text')
            .eq('user_id', userId)
            .or('deleted.eq.false,deleted.is.null');

        if (error) throw error;
        if (!words || words.length === 0) return stats;

        console.log(`[WordCleanup] Starting cleanup for ${words.length} words...`);

        const wordsToDelete: string[] = [];
        const wordsToUpdate: { id: string, text: string }[] = [];

        for (const word of words) {
            stats.totalProcessed++;
            const text = word.text.trim();

            // Rule 1: Single letter words (except 'a', 'i')
            if (text.length < 2 && text.toLowerCase() !== 'a' && text.toLowerCase() !== 'i') {
                wordsToDelete.push(word.id);
                stats.deletedSingleLetter++;
                continue;
            }

            // Rule 2: Spell check
            const result = await aiService.validateSpelling(text, undefined, undefined, { skipLLM: true });
            
            if (!result.isValid) {
                if (result.suggestion) {
                    // Correct it
                    wordsToUpdate.push({ id: word.id, text: result.suggestion });
                    stats.corrected++;
                } else {
                    // No suggestion found -> Add to manual review list
                    stats.issues.push({ id: word.id, text: text });
                    stats.deletedInvalid++;
                }
            }
        }

        // 2. Perform Batch Deletions (ONLY for single letters)
        if (wordsToDelete.length > 0) {
            console.log(`[WordCleanup] Deleting ${wordsToDelete.length} single-letter words...`);
            await supabase
                .from('words')
                .update({ deleted: true })
                .in('id', wordsToDelete);
        }

        // 3. Perform Updates (Corrected words)
        if (wordsToUpdate.length > 0) {
            console.log(`[WordCleanup] Correcting ${wordsToUpdate.length} misspelled words...`);
            for (const update of wordsToUpdate) {
                await supabase
                    .from('words')
                    .update({ text: update.text })
                    .eq('id', update.id);
            }
        }

        return stats;
    } catch (e) {
        console.error("[WordCleanup] Error during cleanup:", e);
        throw e;
    }
};
