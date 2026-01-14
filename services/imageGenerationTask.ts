import { getWordsMissingImage, updateWordImage, uploadImage } from './dataService';
import { aiService } from './ai';

export const generateImagesForMissingWords = async (
    userId: string, 
    onImageUpdated?: (wordId: string, imagePath: string) => void
) => {
    console.log("Checking for missing images...");
    try {
        const missingWords = await getWordsMissingImage(userId);
        
        if (missingWords.length === 0) {
            console.log("No missing images found.");
            return;
        }

        console.log(`Found ${missingWords.length} words missing images. Starting generation...`);

        // Process one by one to avoid rate limits
        for (const word of missingWords) {
            try {
                // Check if aiService is configured properly (e.g. has API key)
                // Assuming aiService handles its own configuration checks internally or throws
                
                console.log(`Generating image for: ${word.text}`);
                const base64Image = await aiService.generateImageHint(word.text);
                
                if (base64Image) {
                    const imagePath = await uploadImage(base64Image, userId);
                    if (imagePath) {
                        await updateWordImage(word.id, imagePath);
                        console.log(`Image updated for: ${word.text}`);
                        if (onImageUpdated) {
                            onImageUpdated(word.id, imagePath);
                        }
                    } else {
                        console.error(`Failed to upload image for: ${word.text}`);
                    }
                } else {
                    console.warn(`Failed to generate image for: ${word.text}`);
                }

                // Add a small delay between requests to be polite to the API
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`Error processing word ${word.text}:`, error);
            }
        }
        console.log("Missing image generation task completed.");
    } catch (e) {
        console.error("Critical error in generateImagesForMissingWords:", e);
    }
};
