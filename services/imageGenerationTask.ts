import { getWordsMissingImage, updateWordImage, uploadImage } from './dataService';
import { aiService } from './ai';

let shouldStop = false;

export const cancelGeneration = () => {
    shouldStop = true;
};

export const generateImagesForMissingWords = async (
    userId: string, 
    logger: (message: string) => void = console.log,
    onImageUpdated?: (wordId: string, imagePath: string) => void
) => {
    shouldStop = false;
    logger("Checking for missing images...");
    try {
        const missingWords = await getWordsMissingImage(userId);
        
        if (missingWords.length === 0) {
            logger("No missing images found.");
            return;
        }

        logger(`Found ${missingWords.length} words missing images. Starting generation...`);

        // Process one by one
        for (const word of missingWords) {
            if (shouldStop) {
                logger("Generation task stopped by user.");
                break;
            }

            let retries = 0;
            let success = false;
            
            while (!success && !shouldStop && retries < 3) {
                 try {
                    logger(`Generating image for: ${word.text}...`);
                    const base64Image = await aiService.generateImageHint(word.text);
                    
                    if (base64Image) {
                        const imagePath = await uploadImage(base64Image, userId);
                        if (imagePath) {
                            await updateWordImage(word.id, imagePath);
                            logger(`✓ Image updated for: ${word.text}`);
                            if (onImageUpdated) {
                                onImageUpdated(word.id, imagePath);
                            }
                            success = true;
                        } else {
                            logger(`Failed to upload image for: ${word.text}`);
                            success = true; // Move on
                        }
                    } else {
                        logger(`Failed to generate image for: ${word.text}`);
                        success = true; // Move on
                    }

                    // Standard Delay: 5 seconds
                    if (success) {
                         await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                } catch (error: any) {
                    const isRateLimit = error?.message?.includes('429') || error?.status === 429;

                    if (isRateLimit) {
                         logger(`Rate limit (429) for ${word.text}. Waiting 60s... (Retry ${retries + 1}/3)`);
                         await new Promise(resolve => setTimeout(resolve, 60000));
                         retries++;
                    } else {
                         logger(`Error processing word ${word.text}: ${error.message || error}`);
                         success = true; // Non-retryable error, move on
                         await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }
        }
        logger("Missing image generation task completed.");
    } catch (e: any) {
        logger(`Critical error in generateImagesForMissingWords: ${e.message || e}`);
    }
};
